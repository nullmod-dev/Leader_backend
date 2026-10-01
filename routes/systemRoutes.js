/**
 * System endpoints:
 *   GET /app-version/check?version=1.2.0   → { supported, minimumVersion }
 *   GET /dev/mailbox?to=<email>&limit=20   → recent emails (non-production only)
 *   GET /docs                              → index of the API reference files
 */
const express = require('express');
const config = require('../config');
const catchAsync = require('../utils/catchAsyncErrors');
const AppError = require('../utils/appError');
const settingsService = require('../services/settingsService');
const { compare } = require('../middlewares/versionGate');
const { DevMail } = require('../models');
const { email: normEmail } = require('../utils/normalize');

const router = express.Router();

/**
 * Forced-upgrade check (AppVersionRepository.checkSupport). Always 200; the
 * body carries the verdict. The version comes from `?version=` or the
 * `X-Client-Version` header.
 */
router.get(
  '/app-version/check',
  catchAsync(async (req, res) => {
    const version = req.query.version || req.get('x-client-version');
    const { minimumClientVersion } = await settingsService.get();
    if (!version) throw AppError.validation({ version: 'Pass ?version= or the X-Client-Version header.' });
    res.json({ supported: compare(version, minimumClientVersion) >= 0, minimumVersion: minimumClientVersion });
  }),
);

/** Development mailbox — read OTP codes and invitations without SMTP. */
router.get(
  '/dev/mailbox',
  catchAsync(async (req, res) => {
    if (!config.devMailbox) throw new AppError('not_found', 404, 'The dev mailbox is disabled.');
    const filter = {};
    if (req.query.to) filter.to = normEmail(req.query.to);
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const mails = await DevMail.find(filter).sort({ createdAt: -1 }).limit(limit);
    res.json({
      items: mails.map((m) => {
        const code = /(\d{4,10})/.exec(m.text || '');
        return { id: m._id, to: m.to, kind: m.kind, subject: m.subject, text: m.text, code: code ? code[1] : null, createdAt: m.createdAt };
      }),
    });
  }),
);

router.get('/docs', (req, res) => {
  res.json({
    guide: 'backend/docs/FRONTEND-INTEGRATION-GUIDE.md',
    reference: 'backend/docs/api/*.md',
    postman: 'backend/postman/Leader.postman_collection.json',
  });
});

module.exports = router;
