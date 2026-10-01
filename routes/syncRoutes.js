/**
 * /api/v1/sync — docs/api/sync.md
 *
 *   POST /sync/push     { operations: [...] (1–50) } → { results, serverTime }
 *   GET  /sync/pull     ?cursor&limit(1–500, 200)&since=now → { changes, nextCursor, hasMore, serverTime }
 *   GET  /sync/status   → { serverTime, latestSeq, catalogue }
 */
const express = require('express');
const { tenantGuard } = require('../middlewares/auth');
const { idempotent } = require('../middlewares/idempotency');
const { validate } = require('../middlewares/validate');
const v = require('../validators/syncValidators');
const ctrl = require('../controllers/tenant/syncController');

const router = express.Router({ mergeParams: true });

router.use(tenantGuard);

router.post('/push', idempotent(), validate(v.push), ctrl.push);
router.get('/pull', ctrl.pull);
router.get('/status', ctrl.status);

module.exports = router;
