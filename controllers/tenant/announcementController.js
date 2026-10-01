/**
 * Announcements — internal notices between administrators, addressed to one
 * or more detachments (/announcements compose + the Notifications Center).
 *
 * Visibility: a caller sees an announcement when it addresses AT LEAST ONE
 * detachment they can view. Publish needs announcement.publish in EVERY
 * addressed detachment (all or nothing); withdraw needs it in ANY of them.
 * Withdraw, never delete.
 */
const catchAsync = require('../../utils/catchAsyncErrors');
const AppError = require('../../utils/appError');
const caps = require('../../config/capabilities');
const { ANNOUNCEMENT_PLACEMENTS, ANNOUNCEMENT_TEXT_MIN, ANNOUNCEMENT_TEXT_MAX } = require('../../config/constants');
const { parseInstant } = require('../../utils/time');
const { saveVersioned } = require('../../services/versioning');
const { Announcement, Detachment } = require('../../models');

/** A client publishedAt is honoured only within this skew of server now. */
const PUBLISHED_AT_SKEW_MS = 5 * 60000;

const toJson = (a) => a.toJSON();

const canSee = (grant, a) => a.detachmentIds.some((id) => caps.canIn(grant, id, 'detachment.view'));

const loadVisible = async (req) => {
  const a = await Announcement.findOne({ _id: req.params.announcementId, tenantId: req.tenantId });
  if (!a || !canSee(req.grant, a)) throw AppError.notFound('announcement');
  return a;
};

exports.list = catchAsync(async (req, res) => {
  const and = [{ tenantId: req.tenantId }];
  const visible = caps.visibleDetachmentIds(req.grant);
  if (visible) and.push({ detachmentIds: { $in: visible } });
  if (req.query.detachmentId) and.push({ detachmentIds: req.query.detachmentId });
  if (req.query.status) and.push({ status: req.query.status });
  const list = await Announcement.find({ $and: and }).sort({ publishedAt: -1, _id: -1 });
  res.json({ announcements: list.map(toJson) });
});

exports.get = catchAsync(async (req, res) => {
  res.json(toJson(await loadVisible(req)));
});

exports.publish = catchAsync(async (req, res) => {
  const b = req.body;
  const fields = {};

  const text = String(b.text ?? '').trim();
  if (text.length < ANNOUNCEMENT_TEXT_MIN || text.length > ANNOUNCEMENT_TEXT_MAX) {
    fields.text = `The text must be ${ANNOUNCEMENT_TEXT_MIN}–${ANNOUNCEMENT_TEXT_MAX} characters after trimming.`;
  }
  const detachmentIds = [...new Set(b.detachmentIds)];

  const now = new Date();
  let publishedAt = now;
  const clientPublishedAt = b.publishedAt ? parseInstant(b.publishedAt, req.tz) : null;
  if (clientPublishedAt && Math.abs(clientPublishedAt.getTime() - now.getTime()) <= PUBLISHED_AT_SKEW_MS) {
    publishedAt = clientPublishedAt;
  }
  const expiresAt = parseInstant(b.expiresAt, req.tz);
  if (!expiresAt) fields.expiresAt = 'expiresAt must be an ISO 8601 instant.';
  else if (expiresAt.getTime() <= publishedAt.getTime()) fields.expiresAt = 'expiresAt must be after publishedAt.';

  const found = await Detachment.find({ tenantId: req.tenantId, _id: { $in: detachmentIds }, status: 'active' }).select('_id');
  const active = new Set(found.map((d) => String(d._id)));
  const unknown = detachmentIds.filter((id) => !active.has(id));
  if (unknown.length) fields.detachmentIds = `Not an active detachment of this team: ${unknown.join(', ')}.`;
  if (Object.keys(fields).length) throw AppError.validation(fields);

  if (!detachmentIds.every((id) => caps.canIn(req.grant, id, 'announcement.publish'))) {
    throw AppError.notPermitted('Requires announcement.publish in every addressed detachment.');
  }

  const wanted = new Set(b.placements || []);
  const placements = ANNOUNCEMENT_PLACEMENTS.filter((p) => p === 'notifications' || wanted.has(p));

  const account = req.auth.account;
  const a = await Announcement.create({
    tenantId: req.tenantId,
    text,
    detachmentIds,
    placements,
    publishedAt,
    expiresAt,
    status: 'active',
    authorId: String(account._id),
    authorName: account.name || undefined,
  });
  res.status(201).json(toJson(a));
});

/** Idempotent: an already-withdrawn announcement answers 200 unchanged. */
exports.withdraw = catchAsync(async (req, res) => {
  const a = await loadVisible(req);
  if (!a.detachmentIds.some((id) => caps.canIn(req.grant, id, 'announcement.publish'))) {
    throw AppError.notPermitted('Requires announcement.publish in an addressed detachment.');
  }
  if (a.status !== 'withdrawn') {
    a.status = 'withdrawn';
    a.withdrawnAt = new Date();
    await saveVersioned(a, toJson);
  }
  res.json(toJson(a));
});
