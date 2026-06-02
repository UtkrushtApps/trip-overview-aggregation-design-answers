# System Design Document

## 1. Problem Summary

The current `GET /api/trips/:id/overview` implementation has three core issues:

1. **High latency**: the database lookup, fares call, and seats call run sequentially.
2. **Low reliability**: downstream calls have no timeout, so one slow internal service can stall the whole request.
3. **Poor failure handling**: the Express 4 async route does not consistently pass failures to middleware, which can lead to unhandled promise rejections.

At 40 RPS, the current p95 is 2.1s. The main lever is to remove avoidable serialization and place a hard upper bound on downstream waiting time.

---

## 2. Goals

This refactor should improve four areas:

- **Latency**: parallelize independent I/O.
- **Reliability**: add timeouts, graceful degradation, and structured error handling.
- **Caching**: reduce repeated load on fares and seats for hot trip IDs.
- **Maintainability**: separate HTTP concerns from orchestration, persistence, caching, and downstream client logic.

Non-goals for the first iteration:

- Replacing PostgreSQL
- Introducing event-driven architecture
- Adding aggressive retry storms on the request path

---

## 3. Current State

Today the handler does this:

1. Read trip from PostgreSQL
2. Call fares service
3. Wait for fares response
4. Call seats service
5. Wait for seats response
6. Return combined JSON

That means total latency is approximately:

`db + fares + seats`

If fares and seats are each slow, the endpoint becomes slow even when the other dependency is healthy.

There are also no request deadlines. If either upstream hangs, this request hangs until the Node process or client gives up.

---

## 4. Proposed Architecture

### High-level flow

```text
Client
  |
  v
Trip Route / Controller
  |
  v
TripOverviewService
  |----> TripRepository (PostgreSQL via Knex)
  |----> FareClient ----> Redis Cache ----> Fares Service
  |----> SeatClient ----> Redis Cache ----> Seats Service
  |
  v
Response Mapper
  |
  v
Client JSON response
```

### Layer responsibilities

- **Route / Controller**
  - Parse request
  - Validate params
  - Call service
  - Translate domain errors into HTTP response

- **TripOverviewService**
  - Orchestrate database lookup and parallel downstream calls
  - Decide partial vs full response behavior
  - Attach metadata about source health/cache usage

- **TripRepository**
  - Encapsulate Knex queries for `trips`

- **FareClient / SeatClient**
  - Own timeout policy
  - Own downstream HTTP request logic
  - Own cache read/write behavior
  - Map raw dependency failures into typed application errors

- **Cache layer**
  - Distributed, shared across instances
  - Read-through pattern with TTL

---

## 5. Concurrency Strategy

### Decision

After the trip row is found in PostgreSQL, the fares and seats calls should run **in parallel** using `Promise.allSettled()`.

### Why `Promise.allSettled()` instead of `Promise.all()`?

- `Promise.all()` fails fast and throws away the other result when one dependency fails.
- `Promise.allSettled()` preserves both outcomes, which is better for:
  - partial responses
  - source-level observability
  - clearer error reporting

### Request sequence

1. Query PostgreSQL for trip by `id`
2. If trip does not exist, return `404 TRIP_NOT_FOUND`
3. Start fares fetch and seats fetch concurrently
4. Apply per-call timeout to each dependency
5. Aggregate results when both settle
6. Return:
   - full response if both succeed
   - partial response if one succeeds and one fails
   - `503 DEPENDENCY_UNAVAILABLE` if both fail and no cache fallback exists

### Expected impact

With parallel downstream I/O, latency becomes approximately:

`db + max(fares, seats)`

Instead of:

`db + fares + seats`

That alone should cut p95 materially. Example:

- Current: 100ms DB + 900ms fares + 900ms seats = 1.9s+
- Proposed: 100ms DB + max(900ms, 900ms) = ~1.0s before additional optimizations
- With timeouts and caching, the practical p95 should drop further

---

## 6. Timeout and Reliability Strategy

### Per-dependency timeout

Each downstream HTTP call should have a hard timeout.

Recommended starting values:

- **Fares timeout**: 400–500ms
- **Seats timeout**: 300–500ms
- **DB query budget**: rely on connection pooling and query optimization; optionally add a query timeout if needed later

The exact values should be tuned from production histograms, but the design principle is:

- keep the total endpoint within a predictable latency budget
- do not allow one internal service to block the entire request indefinitely

### Retry policy

For the synchronous request path, I would **not** add automatic retries initially.

Reasoning:

- retries increase tail latency
- retries multiply load on already unhealthy services
- caching plus timeouts usually gives a better latency/reliability trade-off for read-heavy overview endpoints

If future data shows a high rate of brief connect resets, we can add **at most one bounded retry** for clearly transient network failures, but only if the total budget remains acceptable.

### Graceful degradation policy

I recommend this response policy:

- **Trip missing** → `404`
- **Trip found + both enrichments succeed** → `200` full response
- **Trip found + one enrichment fails but the other succeeds or is cached** → `200` partial response with metadata
- **Trip found + both enrichments fail and nothing usable is cached** → `503`

This improves availability for clients while still being honest when the endpoint cannot provide a meaningful overview.

### Optional resilience enhancements

Good next-step improvements after the first refactor:

- circuit breaker per downstream service
- stale-if-error cache policy
- bulkheads / separate connection pools if traffic grows further

---

## 7. Caching Design

### Technology choice

**Production choice: Redis**

Why Redis:

- shared across all API instances
- supports TTL natively
- fast enough for read-heavy metadata lookups
- avoids inconsistent per-process cache state during horizontal scaling

### Why not only in-memory cache?

In-memory cache is acceptable for local development or as a temporary baseline, but it has drawbacks:

- cache is not shared across instances
- cache is lost on restart
- hit ratio drops when traffic is spread across multiple pods/VMs

So the target architecture should use Redis, even if the starter code uses an in-process cache for simplicity.

### Cache shape

Cache downstream results separately rather than caching the whole overview blob.

Recommended keys:

- `trip-overview:fares:{tripId}`
- `trip-overview:seats:{tripId}`

### TTL recommendations

Use different TTLs because the data changes at different rates.

- **Fares TTL**: 30 seconds
  - pricing changes, but not usually every millisecond
  - short TTL gives good reuse without making fare data overly stale

- **Seats TTL**: 5–10 seconds
  - availability is more volatile
  - shorter TTL reduces stale inventory risk

Trade-off:

- shorter TTL = fresher data, lower hit rate
- longer TTL = better latency and lower dependency load, but more staleness

### Cache flow

#### Cache hit

1. Request enters service
2. Trip is loaded from DB
3. FareClient checks Redis
4. If hit and fresh, return cached fares without calling fares service
5. SeatClient does the same for seats
6. Response includes metadata that source was served from cache

#### Cache miss

1. Request enters service
2. DB lookup succeeds
3. Cache lookup misses for fares and/or seats
4. Missing dependency calls execute in parallel
5. Successful downstream responses are serialized into Redis with TTL
6. Aggregated response is returned

### Stale-if-error option

A strong improvement is to keep a second, slightly longer stale window for fallback when a dependency is down.

Example:

- fares fresh TTL: 30s
- fares stale-if-error window: additional 60s
- seats fresh TTL: 10s
- seats stale-if-error window: additional 20s

Behavior:

- if fresh cache exists, use it
- if no fresh cache and upstream fails, serve stale cache with `meta.stale=true`
- if neither fresh nor stale cache exists, treat as dependency failure

This increases resilience without hiding staleness from clients.

---

## 8. Client-facing Response Contract

### Successful full response

```json
{
  "trip": { "id": "..." },
  "fares": { "currency": "USD", "amount": 120 },
  "seats": { "available": 12 },
  "meta": {
    "partial": false,
    "sources": {
      "fares": { "status": "ok", "source": "network", "cached": false },
      "seats": { "status": "ok", "source": "cache", "cached": true }
    }
  }
}
```

### Partial success response

```json
{
  "trip": { "id": "..." },
  "fares": { "currency": "USD", "amount": 120 },
  "seats": null,
  "meta": {
    "partial": true,
    "sources": {
      "fares": { "status": "ok", "source": "network", "cached": false },
      "seats": { "status": "timeout", "code": "UPSTREAM_TIMEOUT" }
    }
  }
}
```

### Error contract

All non-2xx responses should follow one shape:

```json
{
  "code": "DEPENDENCY_UNAVAILABLE",
  "message": "Trip overview is temporarily unavailable",
  "requestId": "req_abc123",
  "details": {
    "tripId": "..."
  }
}
```

### Canonical error codes

- `INVALID_REQUEST` → 400
- `TRIP_NOT_FOUND` → 404
- `UPSTREAM_TIMEOUT` → 504 or folded into 503 aggregate failure
- `UPSTREAM_ERROR` → 502
- `DEPENDENCY_UNAVAILABLE` → 503
- `INTERNAL_ERROR` → 500
- `NOT_FOUND` → 404 for unknown routes

### Why this contract?

- easy for clients to parse
- consistent across controllers
- exposes stable error codes without leaking implementation detail
- request ID supports debugging with logs

---

## 9. Service Layer Separation Approach

A maintainable file/module structure should look like this conceptually:

```text
src/
  routes/
  controllers/
  services/
    tripOverviewService.js
  repositories/
    tripRepository.js
  clients/
    faresClient.js
    seatsClient.js
  cache/
    overviewCache.js
  middleware/
  config/
```

### Separation details

#### Controller
Thin layer only:

- validate `tripId`
- call service
- `next(err)` on failures

#### TripOverviewService
Business orchestration:

- fetch trip from repository
- kick off fares and seats in parallel
- merge results
- decide full/partial/error response

#### Repository
Database-only concerns:

- `getTripById(id)`

#### Downstream clients
Dependency-only concerns:

- build URLs
- apply timeout
- parse JSON
- map dependency errors
- cache lookup/write

This separation makes the system easier to:

- test in isolation
- change cache implementation
- swap HTTP client libraries
- reuse dependency clients elsewhere

---

## 10. Technology Choices and Trade-offs

### Express
Keep Express because it already exists, the surface area is small, and this endpoint does not require a framework migration.

### Knex + PostgreSQL
Keep Knex and PostgreSQL. The DB is not the primary bottleneck described here. The bigger issue is request orchestration.

### HTTP client
Short term: keep `node-fetch` (or use native `fetch` if the runtime is standardized on modern Node).

Why:

- minimal migration risk
- supports timeout via `AbortController`
- good enough for simple JSON internal calls

Trade-off:

- a library like `undici` may give better performance and modern defaults, but changing the client is less important than fixing concurrency and deadlines first

### Redis for cache
Chosen for shared TTL cache semantics.

Trade-off:

- extra operational dependency
- worth it because the service already depends on multiple backends and horizontal scaling needs shared cache state

### `Promise.allSettled()`
Chosen over `Promise.all()` because partial results matter.

Trade-off:

- slightly more aggregation code
- much better resilience and observability

### No inline retries initially
Chosen to protect latency and avoid load amplification.

Trade-off:

- a few transient errors will not self-heal inside the same request
- acceptable because this is offset by cache reuse and partial response behavior

---

## 11. Observability

To prove the refactor works, add metrics and structured logs.

### Metrics

Track at minimum:

- endpoint latency (`trip_overview_latency_ms`)
- DB query duration
- fares call duration
- seats call duration
- timeout count by service
- upstream error count by service
- cache hit rate by service
- partial response rate
- full failure rate

### Logs

Every request should include:

- `requestId`
- `tripId`
- downstream status for fares and seats
- cache hit/miss
- total duration

This makes it possible to answer:

- did p95 improve?
- which dependency is causing errors?
- are cache TTLs too short?

---

## 12. Rollout Plan

1. Refactor route to use structured error handling
2. Add per-call timeout support
3. Parallelize fares and seats calls
4. Add partial-response contract and source metadata
5. Introduce shared cache for fares and seats
6. Roll out behind a feature flag if possible
7. Compare before/after latency and partial failure rates
8. Tune TTLs and timeout budgets from production data

---

## 13. Expected Outcome

This design should reduce p95 latency primarily by replacing sequential downstream I/O with parallel calls and by capping wait time on unhealthy dependencies. It also makes the endpoint safer to operate by eliminating uncaught async failures, standardizing error responses, and isolating concerns into repository/service/client/cache layers.

In short:

- **Lower latency** through concurrency
- **Better reliability** through timeouts and graceful degradation
- **Lower downstream load** through TTL cache
- **Better maintainability** through service-layer separation
