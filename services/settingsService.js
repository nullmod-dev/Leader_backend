/**
 * Platform policy values (AppSettings singleton), cached for a few seconds.
 * `get()` always returns a plain object with every default filled in.
 */
const { AppSettings } = require('../models');

let cache = null;
let cachedAt = 0;
const TTL_MS = 5000;

const get = async () => {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;
  let doc = await AppSettings.findById('global');
  if (!doc) doc = await AppSettings.create({ _id: 'global' });
  cache = doc.toObject();
  cachedAt = Date.now();
  return cache;
};

/** Synchronous read of the last cached settings (or null before the first get()). */
const peek = () => cache;

const invalidate = () => {
  cache = null;
  cachedAt = 0;
};

/** Apply a partial update (dot-paths allowed) and return the fresh settings. */
const update = async (patch) => {
  await AppSettings.updateOne({ _id: 'global' }, { $set: patch }, { upsert: true, runValidators: true });
  invalidate();
  return get();
};

module.exports = { get, peek, update, invalidate };
