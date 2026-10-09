const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const hpp = require('hpp');
const morgan = require('morgan');
const mongoSanitize = require('express-mongo-sanitize');

const config = require('./config');
const requestId = require('./middlewares/requestId');
const { versionGate } = require('./middlewares/versionGate');
const { apiLimiter } = require('./middlewares/rateLimit');
const errorController = require('./controllers/errorController');
const AppError = require('./utils/appError');
const apiRoutes = require('./routes');

const app = express();

app.set('trust proxy', false);
app.disable('x-powered-by');

app.use(requestId);
app.use(
  helmet({
    // Images under /images are embedded by the mobile app and dashboards.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);
app.use(
  cors({
    // `false` (no list) answers no CORS headers at all, so a browser on
    // another origin is refused; the mobile app never sends an Origin.
    origin: config.corsOrigins.includes('*') ? '*' : config.corsOrigins.length ? config.corsOrigins : false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Client-Version',
      'X-Request-Id',
      'X-Device-Name',
      'X-Device-Id',
    ],
    exposedHeaders: ['X-Request-Id', 'Retry-After', 'Idempotent-Replayed'],
  }),
);
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(mongoSanitize());
app.use(hpp({ whitelist: ['status', 'lifecycle', 'band', 'ids'] }));
if (!config.isTest) app.use(morgan(config.isProduction ? 'combined' : 'dev'));

// Public images (local storage for now — no R2/S3).
app.use(
  '/images',
  express.static(path.join(__dirname, 'public', 'images'), {
    maxAge: config.isProduction ? '30d' : 0,
    fallthrough: false,
  }),
);

app.get('/', (req, res) => {
  res.json({ name: 'Leader API', version: require('./package.json').version, docs: '/api/v1/docs' });
});

app.get('/health', async (req, res) => {
  const mongoose = require('mongoose');
  const up = mongoose.connection.readyState === 1;
  res.status(up ? 200 : 503).json({ status: up ? 'ok' : 'degraded', database: up ? 'connected' : 'disconnected', time: new Date().toISOString() });
});

app.use('/api', apiLimiter, versionGate);
app.use('/api/v1', apiRoutes);

app.all('*', (req, res, next) => {
  next(new AppError('not_found', 404, `Cannot ${req.method} ${req.originalUrl}`));
});

app.use(errorController);

module.exports = app;
