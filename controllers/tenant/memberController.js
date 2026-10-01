/**
 * Team members — /api/v1/members (Flutter /detachment/:id team tab,
 * /detachment/:id/member/:memberId/edit|status, the shift quick-add flow).
 *
 * A TeamMember is a volunteer record, never a login account. Uniqueness inside
 * one detachment (archived/inactive members included):
 *   normalized name            → 409 name_taken
 *   non-empty personalNumber   → 409 number_taken
 * Both are also unique indexes, so a lost race maps to the same codes.
 */
const AppError = require('../../utils/appError');
const catchAsync = require('../../utils/catchAsyncErrors');
const caps = require('../../config/capabilities');
const { Detachment, TeamMember, Counter } = require('../../models');
const ser = require('../../services/serializers');
const usageService = require('../../services/usageService');
const storageService = require('../../services/storageService');
const { assertVersion, saveVersioned } = require('../../services/versioning');
const { nameKey } = require('../../utils/normalize');

const json = (req) => (m) => ser.member(m, { grant: req.grant });

const nameTaken = () =>
  new AppError('name_taken', 409, 'A member with this name already exists in this detachment.', {
    fields: { name: 'A member with this name already exists in this detachment.' },
  });

const numberTaken = () =>
  new AppError('number_taken', 409, 'This personal number is used by another member of this detachment.', {
    fields: { personalNumber: 'This personal number is already in use in this detachment.' },
  });

/** Map a unique-index race to the business code. */
const mapDuplicate = (e) => {
  if (e && e.code === 11000) {
    const keys = Object.keys(e.keyPattern || e.keyValue || {});
    if (keys.includes('personalNumber')) return numberTaken();
    return nameTaken();
  }
  return e;
};

const assertUnique = async (tenantId, detachmentId, { name, personalNumber }, exceptId) => {
  const base = { tenantId, detachmentId };
  if (exceptId) base._id = { $ne: String(exceptId) };
  if (name !== undefined && (await TeamMember.exists({ ...base, nameKey: nameKey(name) }))) throw nameTaken();
  if (personalNumber && (await TeamMember.exists({ ...base, personalNumber }))) throw numberTaken();
};

const assertBodyId = (bodyId, doc) => {
  if (bodyId !== undefined && bodyId !== String(doc._id)) {
    throw AppError.validation({ id: 'The body id must equal the id in the path.' });
  }
};

const loadDetachment = async (req, detachmentId) => {
  const det = await Detachment.findOne({ _id: detachmentId, tenantId: req.tenantId });
  if (!det) throw AppError.notFound('detachment');
  return det;
};

const save = async (member, serialize) => {
  try {
    await saveVersioned(member, serialize);
  } catch (e) {
    throw mapDuplicate(e);
  }
};

// POST /members
exports.create = catchAsync(async (req, res) => {
  const b = req.body;
  const det = await loadDetachment(req, b.detachmentId);
  await usageService.assertCanConsume(req.tenant, 'members');
  await assertUnique(req.tenantId, String(det._id), { name: b.name, personalNumber: b.personalNumber });
  let member;
  try {
    member = await TeamMember.create({
      tenantId: req.tenantId,
      detachmentId: String(det._id),
      name: b.name,
      department: b.department,
      personalNumber: b.personalNumber,
      role: b.role,
      phone: b.phone || null,
    });
  } catch (e) {
    throw mapDuplicate(e);
  }
  res.status(201).json(json(req)(member));
});

// POST /members/from-shift — quick member from the shift-assignment flow
exports.createFromShift = catchAsync(async (req, res) => {
  const b = req.body;
  const det = await loadDetachment(req, b.detachmentId);
  const detachmentId = String(det._id);
  await usageService.assertCanConsume(req.tenant, 'members');
  await assertUnique(req.tenantId, detachmentId, { name: b.name });

  const counter = `shift_member:${req.tenantId}:${detachmentId}`;
  let personalNumber = `shift-${await Counter.next(counter)}`;
  // eslint-disable-next-line no-await-in-loop
  while (await TeamMember.exists({ tenantId: req.tenantId, detachmentId, personalNumber })) {
    // eslint-disable-next-line no-await-in-loop
    personalNumber = `shift-${await Counter.next(counter)}`;
  }
  let member;
  try {
    member = await TeamMember.create({ tenantId: req.tenantId, detachmentId, name: b.name, personalNumber, role: 'member' });
  } catch (e) {
    throw mapDuplicate(e);
  }
  res.status(201).json(json(req)(member));
});

// GET /members/match?detachmentId&name
exports.match = catchAsync(async (req, res) => {
  const { detachmentId, name } = req.query;
  const member = await TeamMember.findOne({ tenantId: req.tenantId, detachmentId, nameKey: nameKey(name) });
  res.json({ match: member ? json(req)(member) : null });
});

// GET /members/:memberId
exports.get = catchAsync(async (req, res) => {
  res.json(json(req)(req.docs.member));
});

// PUT | PATCH /members/:memberId
exports.update = catchAsync(async (req, res) => {
  const member = req.docs.member;
  const b = req.body;
  assertBodyId(b.id, member);

  const roleChange = b.role !== undefined && b.role !== member.role;
  if (roleChange && !caps.canIn(req.grant, member.detachmentId, 'member.role.assign')) {
    throw AppError.notPermitted('Changing the role requires member.role.assign in this detachment.');
  }
  const serialize = json(req);
  assertVersion(member, b.version, serialize);

  const nextName = b.name !== undefined && nameKey(b.name) !== member.nameKey ? b.name : undefined;
  const nextNumber = b.personalNumber !== undefined && b.personalNumber !== member.personalNumber ? b.personalNumber : undefined;
  await assertUnique(req.tenantId, member.detachmentId, { name: nextName, personalNumber: nextNumber }, member._id);

  if (b.name !== undefined) member.name = b.name;
  if (b.department !== undefined) member.department = b.department;
  if (b.personalNumber !== undefined) member.personalNumber = b.personalNumber;
  if (b.phone !== undefined) member.phone = b.phone || null;
  if (roleChange) member.role = b.role;

  await save(member, serialize);
  res.json(serialize(member));
});

// PATCH /members/:memberId/role
exports.setRole = catchAsync(async (req, res) => {
  const member = req.docs.member;
  const serialize = json(req);
  assertVersion(member, req.body.version, serialize);
  member.role = req.body.role;
  await save(member, serialize);
  res.json(serialize(member));
});

// PATCH /members/:memberId/attendance — the vestigial ROSTER value (legacy client path)
exports.setAttendance = catchAsync(async (req, res) => {
  const member = req.docs.member;
  const serialize = json(req);
  assertVersion(member, req.body.version, serialize);
  member.attendance = req.body.attendance;
  await save(member, serialize);
  res.json(serialize(member));
});

// POST /members/:memberId/deactivate | /reactivate
const setActive = (active) =>
  catchAsync(async (req, res) => {
    const member = req.docs.member;
    const serialize = json(req);
    assertVersion(member, req.body && req.body.version, serialize);
    if (member.active !== active) {
      if (active) await usageService.assertCanConsume(req.tenant, 'members');
      member.active = active;
      member.deactivatedAt = active ? undefined : new Date();
      await save(member, serialize);
    }
    res.json(serialize(member));
  });

exports.deactivate = setActive(false);
exports.reactivate = setActive(true);

// DELETE /members/:memberId — shift/workshop lines keep the id (render as a missing member)
exports.remove = catchAsync(async (req, res) => {
  const member = req.docs.member;
  await member.deleteOne();
  await storageService.removeOwnerFiles('member', String(member._id));
  res.status(204).end();
});

// POST /members/:memberId/photo (multipart "image")
exports.setPhoto = catchAsync(async (req, res) => {
  const member = req.docs.member;
  const serialize = json(req);
  let saved;
  try {
    saved = await storageService.saveImage(req.file.buffer, 'member', {
      ownerType: 'member',
      ownerId: String(member._id),
      tenantId: req.tenantId,
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw AppError.validation({ image: 'The file is not a readable image.' });
  }
  const previous = member.photoPath;
  member.photoPath = saved.path;
  try {
    await save(member, serialize);
  } catch (e) {
    await storageService.removeFile(saved.path);
    throw e;
  }
  if (previous) await storageService.removeFile(previous);
  res.json(serialize(member));
});

// DELETE /members/:memberId/photo
exports.removePhoto = catchAsync(async (req, res) => {
  const member = req.docs.member;
  const serialize = json(req);
  const previous = member.photoPath;
  if (previous) {
    member.photoPath = undefined;
    await save(member, serialize);
    await storageService.removeFile(previous);
  }
  res.json(serialize(member));
});
