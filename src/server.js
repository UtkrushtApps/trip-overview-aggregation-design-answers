require('dotenv').config();
const app = require('./app');
const logger = require('./config/logger');

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  logger.info({ message: `Trip Overview API listening on port ${PORT}` });
});

let shuttingDown = false;

function shutdown(signal, exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logger.info({ message: 'Shutdown initiated', signal });

  server.close(() => {
    logger.info({ message: 'HTTP server closed' });
    process.exit(exitCode);
  });

  setTimeout(() => {
    logger.error({ message: 'Forced shutdown after timeout', signal });
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logger.error({
    message: 'Unhandled promise rejection',
    error: error.message,
    stack: error.stack,
  });
});

process.on('uncaughtException', (error) => {
  logger.error({
    message: 'Uncaught exception',
    error: error.message,
    stack: error.stack,
  });

  shutdown('uncaughtException', 1);
});
