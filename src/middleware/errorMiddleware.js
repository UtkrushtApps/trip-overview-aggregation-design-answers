const logger = require('../config/logger');

function notFoundHandler(req, res) {
  res.status(404).json({
    code: 'NOT_FOUND',
    message: 'Route not found',
    requestId: req.requestId,
  });
}

// Express 4-argument error handler — catches errors passed via next(err)
function errorHandler(err, req, res, next) {
  const statusCode = Number.isInteger(err.statusCode) ? err.statusCode : 500;
  const payload = {
    code: err.code || 'INTERNAL_ERROR',
    message: statusCode >= 500 && !err.expose ? 'Internal server error' : err.message,
    requestId: req.requestId,
  };

  if (err.details) {
    payload.details = err.details;
  }

  logger.error({
    message: err.message,
    code: payload.code,
    statusCode,
    requestId: req.requestId,
    details: err.details,
    stack: err.stack,
  });

  res.status(statusCode).json(payload);
}

module.exports = { notFoundHandler, errorHandler };
