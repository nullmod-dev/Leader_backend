/**
 * /api/v1/platform/jobs — background-job heartbeats and manual runs
 * (super_admin). Jobs are idempotent; `Idempotency-Key` is honoured when sent.
 * See docs/api/platform-insights.md.
 */
const express = require('express');
const { platformGuard } = require('../../middlewares/auth');
const { idempotent } = require('../../middlewares/idempotency');
const jobs = require('../../controllers/platform/jobsController');

const router = express.Router({ mergeParams: true });
const idem = idempotent({ required: false });

router.use(platformGuard);

router.get('/', jobs.list);
router.post('/run', idem, jobs.runAll);
router.post('/:name/run', idem, jobs.runOne);

module.exports = router;
