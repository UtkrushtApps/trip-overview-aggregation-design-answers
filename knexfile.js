require('dotenv').config();

function intFromEnv(name, fallback) {
  const parsed = parseInt(process.env[name], 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function productionConnection() {
  if (!process.env.DATABASE_URL) {
    return undefined;
  }

  const sslEnabled = process.env.DB_SSL === 'true';

  return {
    connectionString: process.env.DATABASE_URL,
    ssl: sslEnabled ? { rejectUnauthorized: false } : false,
  };
}

module.exports = {
  development: {
    client: 'pg',
    connection: {
      host: process.env.DB_HOST || '127.0.0.1',
      port: intFromEnv('DB_PORT', 5432),
      database: process.env.DB_NAME || 'trip_overview',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
    },
    pool: {
      min: intFromEnv('DB_POOL_MIN', 2),
      max: intFromEnv('DB_POOL_MAX', 10),
    },
    migrations: {
      directory: './migrations',
    },
  },
  production: {
    client: 'pg',
    connection: productionConnection(),
    pool: {
      min: intFromEnv('DB_POOL_MIN', 2),
      max: intFromEnv('DB_POOL_MAX', 10),
    },
    migrations: {
      directory: './migrations',
    },
  },
};
