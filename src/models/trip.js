// Trip model — describes the shape of a row in the 'trips' table.
// Accessed via Knex query builder (db('trips').where(...)).

/**
 * trips table columns:
 *   id          UUID, primary key
 *   origin      VARCHAR — departure location
 *   destination VARCHAR — arrival location
 *   depart_at   TIMESTAMPTZ — scheduled departure datetime
 *   arrive_at   TIMESTAMPTZ — scheduled arrival datetime
 *   carrier     VARCHAR — airline or transport carrier code
 *   status      VARCHAR — one of: active, cancelled, completed
 *   created_at  TIMESTAMPTZ
 *   updated_at  TIMESTAMPTZ
 */

module.exports = {
  TABLE: 'trips',
};
