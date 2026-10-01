/**
 * Security signals + throttling budgets. Failures are counted per bucket
 * (e.g. `login:<emailHash>`, `link:<accountId>`) inside a sliding window; a
 * bucket over budget answers `429 rate_limited` with `retryAfterSeconds`.
 */
const { SecuritySignal } = require('../models');
const { sha256 } = require('../utils/ids');
const mask = require('../utils/mask');
const AppError = require('../utils/appError');

const signal = async (kind, { accountId, email, ip, tenantId } = {}) => {
  await SecuritySignal.create({
    kind,
    accountId,
    emailHash: email ? sha256(String(email).toLowerCase()) : undefined,
    ipMasked: ip ? mask.ip(ip) : undefined,
    tenantId,
  });
};

/**
 * Throw 429 when `kind` failures matching `filter` within `windowMinutes`
 * reached `max`.
 */
const assertBudget = async (kind, filter, { max, windowMinutes }) => {
  const since = new Date(Date.now() - windowMinutes * 60000);
  const q = { kind, occurredAt: { $gte: since }, ...filter };
  const count = await SecuritySignal.countDocuments(q);
  if (count >= max) {
    const oldest = await SecuritySignal.findOne(q).sort({ occurredAt: 1 });
    const retryAt = oldest ? oldest.occurredAt.getTime() + windowMinutes * 60000 : Date.now() + windowMinutes * 60000;
    const retryAfterSeconds = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
    throw new AppError('rate_limited', 429, 'Too many attempts. Try again later.', {
      retryAfterSeconds,
      retryAvailableAt: new Date(retryAt).toISOString(),
    });
  }
};

const emailFilter = (email) => ({ emailHash: sha256(String(email).toLowerCase()) });

module.exports = { signal, assertBudget, emailFilter };
