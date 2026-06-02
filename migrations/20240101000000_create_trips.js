exports.up = async function (knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  const exists = await knex.schema.hasTable('trips');
  if (exists) {
    return;
  }

  return knex.schema.createTable('trips', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('origin').notNullable();
    table.string('destination').notNullable();
    table.timestamp('depart_at', { useTz: true }).notNullable();
    table.timestamp('arrive_at', { useTz: true }).notNullable();
    table.string('carrier').notNullable();
    table.string('status').notNullable().defaultTo('active');
    table.timestamps(true, true);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists('trips');
};
