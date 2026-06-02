const express = require('express');
const tripRoutes = require('./routes/trips');
const { notFoundHandler, errorHandler } = require('./middleware/errorMiddleware');

const app = express();

function generateRequestId() {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

app.disable('x-powered-by');
app.use(express.json());

app.use((req, res, next) => {
  const headerRequestId = req.headers['x-request-id'];
  const requestId = Array.isArray(headerRequestId)
    ? headerRequestId[0]
    : headerRequestId || generateRequestId();

  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/trips', tripRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
