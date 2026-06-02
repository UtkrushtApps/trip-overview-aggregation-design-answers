const knex = require('knex');
const knexConfig = require('../../knexfile');

const env = process.env.NODE_ENV || 'development';
const config = knexConfig[env];

if (!config) {
  throw new Error(`Missing knex configuration for environment: ${env}`);
}

const db = knex(config);

module.exports = db;
