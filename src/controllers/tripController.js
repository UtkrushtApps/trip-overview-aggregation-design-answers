const db = require('../config/db');
const fetch = require('node-fetch');
const logger = require('../config/logger');
const Trip = require('../models/trip');

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const faresCache = new Map();
const seatsCache = new Map();

function intFromEnv(name, fallback) {
  const parsed = parseInt(process.env[name], 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const DOWNSTREAM_TIMEOUT_MS = intFromEnv('DOWNSTREAM_TIMEOUT_MS', 500);
const FARES_CACHE_TTL_MS = intFromEnv('FARES_CACHE_TTL_MS', 30000);
const SEATS_CACHE_TTL_MS = intFromEnv('SEATS_CACHE_TTL_MS', 10000);

function createAppError(statusCode, code, message, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (details) {
    error.details = details;
  }
  return error;
}

function isValidUuid(value) {
  return UUID_REGEX.test(value);
}

function getCacheEntry(cache, key) {
  const entry = cache.get(key);

  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }

  return entry.value;
}

function setCacheEntry(cache, key, value, ttlMs) {
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

function buildServiceUrl(baseUrl, path, serviceName) {
  if (!baseUrl) {
    throw createAppError(
      500,
      'CONFIGURATION_ERROR',
      `${serviceName} service URL is not configured`
    );
  }

  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

async function fetchWithTimeout(url, options, timeoutMs, serviceName) {
  if (typeof AbortController === 'function') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, {
        ...options,
        signal: controller.signal,
      });
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw createAppError(504, 'UPSTREAM_TIMEOUT', `${serviceName} service timed out`, {
          service: serviceName,
          timeoutMs,
        });
      }

      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  let timer;
  const fetchPromise = fetch(url, options);

  // Prevent late rejections from becoming unhandled if the timeout wins the race.
  fetchPromise.catch(() => {});

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        createAppError(504, 'UPSTREAM_TIMEOUT', `${serviceName} service timed out`, {
          service: serviceName,
          timeoutMs,
        })
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([fetchPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithTimeout(url, { serviceName, timeoutMs, requestId }) {
  let response;

  try {
    response = await fetchWithTimeout(
      url,
      {
        headers: {
          Accept: 'application/json',
          'x-request-id': requestId,
        },
      },
      timeoutMs,
      serviceName
    );
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }

    throw createAppError(502, 'UPSTREAM_ERROR', `${serviceName} service request failed`, {
      service: serviceName,
      reason: error.message,
    });
  }

  if (!response.ok) {
    throw createAppError(502, 'UPSTREAM_ERROR', `${serviceName} service returned an invalid response`, {
      service: serviceName,
      upstreamStatus: response.status,
    });
  }

  try {
    return await response.json();
  } catch (error) {
    throw createAppError(502, 'UPSTREAM_ERROR', `${serviceName} service returned invalid JSON`, {
      service: serviceName,
      reason: error.message,
    });
  }
}

async function getCachedServicePayload({
  cache,
  cacheKey,
  ttlMs,
  url,
  serviceName,
  requestId,
}) {
  const cached = getCacheEntry(cache, cacheKey);

  if (cached) {
    return {
      data: cached,
      source: 'cache',
    };
  }

  const data = await fetchJsonWithTimeout(url, {
    serviceName,
    timeoutMs: DOWNSTREAM_TIMEOUT_MS,
    requestId,
  });

  setCacheEntry(cache, cacheKey, data, ttlMs);

  return {
    data,
    source: 'network',
  };
}

function toSourceMeta(result) {
  if (result.status === 'fulfilled') {
    return {
      status: 'ok',
      source: result.value.source,
      cached: result.value.source === 'cache',
    };
  }

  const error = result.reason || {};

  return {
    status: error.code === 'UPSTREAM_TIMEOUT' ? 'timeout' : 'error',
    code: error.code || 'UPSTREAM_ERROR',
  };
}

async function getTripById(id) {
  return db(Trip.TABLE).where({ id }).first();
}

/**
 * GET /api/trips/:id/overview
 * Fetches trip data from PostgreSQL and enriches it with fares and seat
 * availability data in parallel. Downstream calls are time-bounded and can
 * return partial data when one dependency fails.
 */
async function tripOverviewHandler(req, res, next) {
  const { id } = req.params;
  const requestId = req.requestId;

  try {
    if (!isValidUuid(id)) {
      throw createAppError(400, 'INVALID_REQUEST', 'Trip id must be a valid UUID', {
        tripId: id,
      });
    }

    const trip = await getTripById(id);

    if (!trip) {
      throw createAppError(404, 'TRIP_NOT_FOUND', 'Trip not found', { tripId: id });
    }

    const faresUrl = buildServiceUrl(
      process.env.FARES_SERVICE_URL,
      `/internal/fares/${id}`,
      'fares'
    );
    const seatsUrl = buildServiceUrl(
      process.env.SEATS_SERVICE_URL,
      `/internal/seats/${id}`,
      'seats'
    );

    const [faresResult, seatsResult] = await Promise.allSettled([
      getCachedServicePayload({
        cache: faresCache,
        cacheKey: id,
        ttlMs: FARES_CACHE_TTL_MS,
        url: faresUrl,
        serviceName: 'fares',
        requestId,
      }),
      getCachedServicePayload({
        cache: seatsCache,
        cacheKey: id,
        ttlMs: SEATS_CACHE_TTL_MS,
        url: seatsUrl,
        serviceName: 'seats',
        requestId,
      }),
    ]);

    const meta = {
      partial: faresResult.status === 'rejected' || seatsResult.status === 'rejected',
      sources: {
        fares: toSourceMeta(faresResult),
        seats: toSourceMeta(seatsResult),
      },
    };

    if (faresResult.status === 'rejected' && seatsResult.status === 'rejected') {
      throw createAppError(
        503,
        'DEPENDENCY_UNAVAILABLE',
        'Trip overview is temporarily unavailable',
        {
          tripId: id,
          sources: meta.sources,
        }
      );
    }

    logger.info({
      message: 'Trip overview fetched',
      requestId,
      tripId: id,
      partial: meta.partial,
      sources: meta.sources,
    });

    return res.json({
      trip,
      fares: faresResult.status === 'fulfilled' ? faresResult.value.data : null,
      seats: seatsResult.status === 'fulfilled' ? seatsResult.value.data : null,
      meta,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = { tripOverviewHandler };
