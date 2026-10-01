/* eslint-disable no-console */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, 'config.env') });

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION — shutting down', err);
  process.exit(1);
});

const mongoose = require('mongoose');
const config = require('./config');
const app = require('./app');
const jobs = require('./jobs');
const settingsService = require('./services/settingsService');

const start = async () => {
  await mongoose.connect(config.mongoUri);
  console.log(`MongoDB connected → ${mongoose.connection.host}:${mongoose.connection.port}/${mongoose.connection.name}`);
  await mongoose.syncIndexes();
  await settingsService.get(); // make sure the settings singleton exists

  const server = app.listen(config.port, () => {
    console.log(`Leader API listening on http://localhost:${config.port} (${config.env})`);
  });

  if (config.jobsEnabled) jobs.start();

  const shutdown = (signal) => {
    console.log(`${signal} received — closing`);
    jobs.stop();
    server.close(() => mongoose.disconnect().then(() => process.exit(0)));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => {
    console.error('UNHANDLED REJECTION — shutting down', err);
    server.close(() => process.exit(1));
  });
};

start().catch((err) => {
  console.error('Failed to start:', err.message);
  console.error('Is MongoDB running? Start it with `npm run db` in another terminal.');
  process.exit(1);
});
