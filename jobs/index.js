/**
 * Background jobs — a tiny interval runner (no queue needed at this scale).
 *
 * Each file in ./definitions exports `{ name, description, run }` where
 * `run()` resolves to the number of affected records. Every run is recorded in
 * `job_runs` (heartbeat for /platform/health's `background_jobs` signal and
 * GET /platform/jobs). Jobs are idempotent: running one twice is harmless.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

let timer = null;
let running = false;

const loadDefinitions = () => {
  const dir = path.join(__dirname, 'definitions');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => require(path.join(dir, f)))
    .filter((d) => d && d.name && typeof d.run === 'function');
};

/** Run one job by name (or every job) now, recording the outcome. */
const runJob = async (definition) => {
  const { JobRun } = require('../models');
  const startedAt = new Date();
  try {
    const affected = (await definition.run()) || 0;
    await JobRun.updateOne(
      { _id: definition.name },
      { $set: { lastRunAt: startedAt, lastSuccessAt: new Date(), lastStatus: 'ok', lastError: null, lastAffected: affected }, $inc: { runs: 1 } },
      { upsert: true },
    );
    return { name: definition.name, status: 'ok', affected };
  } catch (err) {
    await JobRun.updateOne(
      { _id: definition.name },
      { $set: { lastRunAt: startedAt, lastStatus: 'failed', lastError: String(err.message).slice(0, 300) }, $inc: { runs: 1 } },
      { upsert: true },
    );
    if (!config.isTest) console.error(`[job:${definition.name}]`, err.message);
    return { name: definition.name, status: 'failed', error: err.message };
  }
};

const runAll = async () => {
  if (running) return [];
  running = true;
  try {
    const results = [];
    for (const def of loadDefinitions()) results.push(await runJob(def));
    return results;
  } finally {
    running = false;
  }
};

const start = () => {
  if (timer) return;
  timer = setInterval(() => {
    runAll().catch(() => {});
  }, config.jobsIntervalSeconds * 1000);
  timer.unref();
  runAll().catch(() => {});
};

const stop = () => {
  if (timer) clearInterval(timer);
  timer = null;
};

module.exports = { start, stop, runAll, runJob, loadDefinitions };
