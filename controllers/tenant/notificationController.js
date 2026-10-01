/**
 * Notifications — /api/v1/notifications (Flutter /notifications, the
 * Notifications Center). The feed is derived on every read
 * (services/notificationFeedService.js); read / cleared state is per ACCOUNT.
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const feedService = require('../../services/notificationFeedService');

const buildFeed = (req) =>
  feedService.feed({
    tenant: req.tenant,
    account: req.auth.account,
    grant: req.grant,
    detachment: req.docs.detachment,
    tz: req.tz,
  });

// GET /notifications?detachmentId
exports.feed = catchAsync(async (req, res) => {
  res.json({ notifications: await buildFeed(req) });
});

// GET /notifications/unread-count?detachmentId
exports.unreadCount = catchAsync(async (req, res) => {
  res.json({ count: feedService.unreadCount(await buildFeed(req)) });
});

// PUT /notifications/read { ids }
exports.markRead = catchAsync(async (req, res) => {
  const state = await feedService.addIds({ accountId: req.auth.account._id, tenantId: req.tenantId, field: 'readIds', ids: req.body.ids });
  res.json({ readIds: state.readIds });
});

// PUT /notifications/cleared { ids }
exports.markCleared = catchAsync(async (req, res) => {
  const state = await feedService.addIds({ accountId: req.auth.account._id, tenantId: req.tenantId, field: 'clearedIds', ids: req.body.ids });
  res.json({ clearedIds: state.clearedIds });
});

// GET /notifications/state
exports.state = catchAsync(async (req, res) => {
  res.json(await feedService.stateOf(req.auth.account._id));
});
