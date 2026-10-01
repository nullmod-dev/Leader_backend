/**
 * Offline sync (/sync) — the server half of the Flutter outbox
 * (FRONTEND-BACKEND-INTEGRATION.md §3, §5).
 *
 * PUSH. Each outbox operation is replayed as an INTERNAL LOOPBACK HTTP request
 * to the REST endpoint that owns it (`CATALOGUE[kind]`), carrying the
 * caller's own `Authorization`, `Idempotency-Key: <operationId>` and
 * `X-Client-Version`. That deliberately reuses every route's validation,
 * authorization chain (feature → capability → plan limit), optimistic
 * concurrency and idempotency, so a replayed write carries no authority of
 * its own: it is re-authorized, at replay time, exactly like a live request.
 * Operations run sequentially, in the order sent.
 *
 * PULL. The per-tenant `change_log` (written by the base plugin on every
 * upsert/delete) is read after a cursor, collapsed to the last change per
 * entity within the page, filtered by the caller's current visibility and
 * module flags, and served with the entity's ordinary wire shape.
 */
const caps = require('../config/capabilities');
const AppError = require('../utils/appError');
const cursorUtil = require('../utils/cursor');
const serializers = require('./serializers');
const rollups = require('./rollups');
const models = require('../models');

// =====================================================================================
// PUSH
// =====================================================================================

/**
 * The kind catalogue: outbox `kind` → the REST endpoint that owns the write.
 * `{param}` segments are filled from the operation's payload (and removed
 * from the body); every remaining payload field is the request body, and an
 * operation-level `version` is merged into it.
 */
const CATALOGUE = {
  'inventory.movement.add': { method: 'POST', path: '/inventory-items/{itemId}/movements' },
  'shift.attendance.checkIn': { method: 'POST', path: '/shifts/{shiftId}/members/{memberId}/check-in' },
  'shift.attendance.checkOut': { method: 'POST', path: '/shifts/{shiftId}/members/{memberId}/check-out' },
  'shift.attendance.absent': { method: 'POST', path: '/shifts/{shiftId}/members/{memberId}/absent' },
  'shift.attendance.reset': { method: 'POST', path: '/shifts/{shiftId}/members/{memberId}/reset' },
  'shift.attendance.mark': { method: 'PATCH', path: '/shifts/{shiftId}/members/{memberId}/attendance' },
  'shift.attendance.correct': { method: 'POST', path: '/shifts/{shiftId}/members/{memberId}/attendance-corrections' },
  'shift.assign': { method: 'POST', path: '/shifts/{shiftId}/assignments' },
  'shift.unassign': { method: 'DELETE', path: '/shifts/{shiftId}/assignments/{memberId}' },
  'shift.update': { method: 'PATCH', path: '/shifts/{shiftId}' },
  'member.update': { method: 'PATCH', path: '/members/{memberId}' },
  'workshop.participant.attendance': { method: 'PATCH', path: '/workshop-participants/{participantId}/attendance' },
  'workshop.participant.payment': { method: 'PATCH', path: '/workshop-participants/{participantId}/payment' },
};

const BUILT_IN_KINDS = new Set(Object.keys(CATALOGUE));

/** Test seam: add (or replace) a kind → endpoint mapping. */
const registerKind = (kind, { method, path }) => {
  CATALOGUE[kind] = { method: String(method).toUpperCase(), path };
};

/** Test seam: remove a kind added with registerKind (built-in kinds are kept). */
const unregisterKind = (kind) => {
  if (!BUILT_IN_KINDS.has(kind)) delete CATALOGUE[kind];
};

const catalogueKinds = () => Object.keys(CATALOGUE);

const PARAM_RE = /\{([A-Za-z0-9_]+)\}/g;

/**
 * Resolve an operation into { method, path, body } or { missing: [params] }.
 * Returns null for an unknown kind.
 */
const buildOperationRequest = (op) => {
  const entry = CATALOGUE[op.kind];
  if (!entry) return null;
  const payload = op.payload && typeof op.payload === 'object' ? op.payload : {};
  const params = [...entry.path.matchAll(PARAM_RE)].map((m) => m[1]);
  const missing = params.filter((p) => {
    const v = payload[p];
    return v === undefined || v === null || (typeof v !== 'string' && typeof v !== 'number') || String(v).trim() === '';
  });
  if (missing.length) return { missing };
  const path = entry.path.replace(PARAM_RE, (_, p) => encodeURIComponent(String(payload[p]).trim()));
  const body = { ...payload };
  params.forEach((p) => delete body[p]);
  if (op.version !== undefined && op.version !== null) body.version = op.version;
  return { method: entry.method, path, body: Object.keys(body).length ? body : undefined };
};

/** 4xx codes that mean "try again later", not "this write is invalid". */
const RETRY_CODES = new Set(['idempotency_in_progress', 'authentication_expired', 'rate_limited', 'upgrade_required']);
const RETRY_STATUSES = new Set([401, 408, 426, 429]);

/**
 * Map one endpoint response onto a push result. Pure — unit-tested with fake
 * responses.
 * @param op   { operationId, kind }
 * @param res  { status, body, replayed }  (status 0 = no HTTP response)
 */
const mapResponse = (op, { status, body, replayed = false }) => {
  const base = { operationId: op.operationId, kind: op.kind, httpStatus: status };
  if (status >= 200 && status < 300) {
    const out = { ...base, status: replayed ? 'duplicate' : 'applied', terminal: true };
    if (body !== undefined && body !== null && body !== '') out.entity = body;
    return out;
  }
  const err = (body && typeof body === 'object' && body.error) || {};
  const code = err.code || (status >= 500 || status === 0 ? 'server' : 'unknown');
  const out = { ...base, code };
  if (err.message) out.message = err.message;

  if (status === 409 && code === 'stale_write') {
    out.status = 'conflict';
    out.terminal = false;
    if (err.currentVersion !== undefined) out.currentVersion = err.currentVersion;
    if (err.currentRecord !== undefined) out.currentRecord = err.currentRecord;
    return out;
  }
  if (status === 0 || status >= 500 || RETRY_CODES.has(code) || RETRY_STATUSES.has(status)) {
    out.status = 'retry';
    out.terminal = false;
    if (err.retryAfterSeconds) out.retryAfterSeconds = err.retryAfterSeconds;
    return out;
  }
  out.status = 'rejected';
  out.terminal = true;
  if (err.fields) out.fields = err.fields;
  return out;
};

const rejected = (op, code, message, fields) => {
  const out = { operationId: op.operationId, kind: op.kind, status: 'rejected', httpStatus: 422, code, message, terminal: true };
  if (fields) out.fields = fields;
  return out;
};

const LOOPBACK_TIMEOUT_MS = 30000;

/** Dispatch one operation to its endpoint over loopback. */
const dispatch = async (req, op, index) => {
  const built = buildOperationRequest(op);
  if (!built) return rejected(op, 'unsupported_operation', `Unknown operation kind "${op.kind}".`);
  if (built.missing) {
    const fields = {};
    built.missing.forEach((p) => {
      fields[`payload.${p}`] = `${p} is required.`;
    });
    return rejected(op, 'validation', 'The operation payload is missing a path identifier.', fields);
  }

  const headers = {
    Accept: 'application/json',
    'Idempotency-Key': op.operationId,
    'X-Request-Id': `${req.id}_${index}`.slice(0, 64),
  };
  const authorization = req.get('authorization');
  if (authorization) headers.Authorization = authorization;
  const clientVersion = req.get('x-client-version');
  if (clientVersion) headers['X-Client-Version'] = clientVersion;
  const device = req.get('x-device-name');
  if (device) headers['X-Device-Name'] = device;
  const ua = req.get('user-agent');
  if (ua) headers['User-Agent'] = ua;
  // Keep per-client rate limiting and security signals attributed to the caller.
  if (req.ip) headers['X-Forwarded-For'] = String(req.ip).replace(/^::ffff:/, '');
  if (built.body !== undefined) headers['Content-Type'] = 'application/json';

  const url = `http://127.0.0.1:${req.socket.localPort}/api/v1${built.path}`;
  let response;
  let text;
  try {
    response = await fetch(url, {
      method: built.method,
      headers,
      body: built.body !== undefined ? JSON.stringify(built.body) : undefined,
      signal: AbortSignal.timeout(LOOPBACK_TIMEOUT_MS),
    });
    text = await response.text();
  } catch (e) {
    return mapResponse(op, { status: 0, body: { error: { code: 'network', message: 'The operation could not be delivered.' } } });
  }
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (e) {
      body = null;
    }
  }
  return mapResponse(op, {
    status: response.status,
    body,
    replayed: String(response.headers.get('idempotent-replayed') || '').toLowerCase() === 'true',
  });
};

/** Replay a batch, sequentially and in order. */
const push = async (req, operations) => {
  const results = [];
  for (let i = 0; i < operations.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await dispatch(req, operations[i], i));
  }
  return { results, serverTime: new Date().toISOString() };
};

// =====================================================================================
// PULL
// =====================================================================================

const MODEL_OF = {
  detachment_group: 'DetachmentGroup',
  detachment: 'Detachment',
  team_member: 'TeamMember',
  shift: 'Shift',
  shift_template: 'ShiftTemplate',
  inventory_item: 'InventoryItem',
  inventory_movement: 'InventoryMovement',
  workshop: 'Workshop',
  workshop_participant: 'WorkshopParticipant',
  announcement: 'Announcement',
};

/** Module entities vanish from the feed while their module is off. */
const FEATURE_OF = {
  inventory_item: 'inventory',
  inventory_movement: 'inventory',
  workshop: 'workshops',
  workshop_participant: 'workshops',
  announcement: 'announcements',
};

const ENTITY_TYPES = Object.keys(MODEL_OF);

const latestSeq = async (tenantId) => {
  const last = await models.ChangeLog.findOne({ tenantId }).sort({ seq: -1 }).select('seq').lean();
  return last ? last.seq : 0;
};

const decodeCursor = (raw) => {
  const c = cursorUtil.decode(raw);
  if (!c) return 0;
  if (!Number.isInteger(c.seq) || c.seq < 0) throw AppError.validation({ cursor: 'The cursor is not valid.' }, 'Invalid cursor.');
  return c.seq;
};

/** Serialize the current documents of one entity type → Map(id → wire JSON). */
const serializeType = async (type, docs, ctx) => {
  const { tenantId, grant, tz } = ctx;
  const out = new Map();
  if (!docs.length) return out;
  switch (type) {
    case 'detachment_group': {
      const roll = await rollups.groupRollups(tenantId, docs.map((d) => d._id), tz);
      docs.forEach((d) => out.set(String(d._id), serializers.detachmentGroup(d, roll.get(String(d._id)))));
      break;
    }
    case 'detachment': {
      const roll = await rollups.detachmentRollups(tenantId, docs.map((d) => d._id), tz);
      docs.forEach((d) => out.set(String(d._id), serializers.detachment(d, roll.get(String(d._id)))));
      break;
    }
    case 'team_member':
      docs.forEach((d) => out.set(String(d._id), serializers.member(d, { grant })));
      break;
    case 'shift': {
      const list = await serializers.shifts(tenantId, docs, { grant });
      list.forEach((s) => out.set(s.id, s));
      break;
    }
    case 'shift_template':
      docs.forEach((d) => out.set(String(d._id), serializers.template(d)));
      break;
    case 'inventory_item':
      docs.forEach((d) => out.set(String(d._id), serializers.inventoryItem(d)));
      break;
    case 'inventory_movement':
      docs.forEach((d) => out.set(String(d._id), serializers.movement(d)));
      break;
    case 'workshop': {
      const list = await serializers.workshops(tenantId, docs, { grant });
      list.forEach((w) => out.set(w.id, w));
      break;
    }
    case 'workshop_participant':
      docs.forEach((d) => out.set(String(d._id), serializers.participant(d)));
      break;
    case 'announcement':
      docs.forEach((d) => out.set(String(d._id), d.toJSON()));
      break;
    default:
      break;
  }
  return out;
};

/**
 * Detachment scope of a CURRENT document for visibility:
 *   - a string id  → visible iff that detachment is visible
 *   - an array     → visible iff any of them is visible (announcements)
 *   - 'group'      → a group: visible iff it contains a visible detachment
 *   - null         → organisation-level (workshops) → visible
 */
const scopeOf = (type, doc) => {
  if (type === 'detachment') return String(doc._id);
  if (type === 'detachment_group') return 'group';
  if (type === 'announcement') return doc.detachmentIds || [];
  return doc.detachmentId || null;
};

/**
 * GET /sync/pull
 * @param ctx { tenant, grant, tz }
 * @param q   { cursor?, limit?, since? }
 */
const pull = async (ctx, q = {}) => {
  const tenantId = String(ctx.tenant._id);
  const serverTime = new Date().toISOString();
  const limit = cursorUtil.limitOf(q.limit, 200, 500);

  if (q.since !== undefined && q.since !== '') {
    if (q.since !== 'now') throw AppError.validation({ since: 'since only accepts "now".' });
    const seq = await latestSeq(tenantId);
    return { changes: [], nextCursor: cursorUtil.encode({ seq }), hasMore: false, serverTime };
  }

  const after = decodeCursor(q.cursor);
  const rows = await models.ChangeLog.find({ tenantId, seq: { $gt: after } })
    .sort({ seq: 1 })
    .limit(limit + 1)
    .lean();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = cursorUtil.encode({ seq: page.length ? page[page.length - 1].seq : after });

  // Collapse: the last change per entity within the page wins (keeps its seq).
  const last = new Map();
  page.forEach((r) => last.set(`${r.entityType}:${r.entityId}`, r));
  const collapsed = [...last.values()]
    .filter((r) => MODEL_OF[r.entityType])
    .filter((r) => !FEATURE_OF[r.entityType] || ctx.tenant.featureEnabled(FEATURE_OF[r.entityType]))
    .sort((a, b) => a.seq - b.seq);

  // Visibility (current grant).
  const visible = caps.visibleDetachmentIds(ctx.grant);
  const visibleSet = visible === null ? null : new Set(visible);
  let visibleGroups = null;
  if (visibleSet) {
    const dets = await models.Detachment.find({ tenantId, _id: { $in: visible } }).select('detachmentGroupId').lean();
    visibleGroups = new Set(dets.map((d) => d.detachmentGroupId));
  }
  const canSee = (type, scope, entityId) => {
    if (!visibleSet) return true;
    if (scope === 'group') return visibleGroups.has(String(entityId));
    if (Array.isArray(scope)) return scope.some((id) => visibleSet.has(id));
    if (scope === null || scope === undefined) return true;
    return visibleSet.has(String(scope));
  };

  // Load the current documents of every upserted entity, one query per type.
  const idsByType = new Map();
  collapsed
    .filter((r) => r.op === 'upsert')
    .forEach((r) => {
      if (!idsByType.has(r.entityType)) idsByType.set(r.entityType, []);
      idsByType.get(r.entityType).push(r.entityId);
    });
  const docsByType = new Map();
  await Promise.all(
    [...idsByType.entries()].map(async ([type, ids]) => {
      const docs = await models[MODEL_OF[type]].find({ tenantId, _id: { $in: ids } });
      docsByType.set(type, new Map(docs.map((d) => [String(d._id), d])));
    }),
  );

  const changes = [];
  const toSerialize = new Map();
  const hidden = []; // upserts of detachment-scoped entities the caller cannot see (now)
  collapsed.forEach((r) => {
    const doc = r.op === 'upsert' ? (docsByType.get(r.entityType) || new Map()).get(String(r.entityId)) : null;
    if (!doc) {
      // Deleted (tombstone), or an upsert whose document no longer exists. The
      // row carries the detachment the entity lived in when it was deleted.
      const loggedScope = r.entityType === 'detachment' ? r.entityId : r.entityType === 'detachment_group' ? 'group' : r.detachmentId || null;
      if (!canSee(r.entityType, loggedScope, r.entityId)) return;
      const change = { seq: r.seq, entityType: r.entityType, entityId: r.entityId, op: 'delete' };
      if (r.version !== undefined && r.version !== null) change.version = r.version;
      changes.push(change);
      return;
    }
    const scope = scopeOf(r.entityType, doc);
    if (!canSee(r.entityType, scope, r.entityId)) {
      if (typeof scope === 'string' && scope !== 'group' && r.entityType !== 'detachment') hidden.push(r);
      return;
    }
    const change = { seq: r.seq, entityType: r.entityType, entityId: r.entityId, op: 'upsert' };
    if (doc.version !== undefined && doc.version !== null) change.version = doc.version;
    changes.push(change);
    if (!toSerialize.has(r.entityType)) toSerialize.set(r.entityType, []);
    toSerialize.get(r.entityType).push(doc);
  });

  // An entity that just LEFT the caller's scope (e.g. a member transferred to
  // another detachment) answers `delete`, so the client drops its copy. A log
  // row records the detachment AFTER the change, so look at the entity's
  // previous row: if that one was visible, the client may hold it.
  if (hidden.length && visibleSet) {
    const everVisible = new Set(
      await models.ChangeLog.distinct('entityId', {
        tenantId,
        entityId: { $in: hidden.map((r) => r.entityId) },
        detachmentId: { $in: visible },
      }),
    );
    const exits = await Promise.all(
      hidden
        .filter((r) => everVisible.has(r.entityId))
        .map(async (r) => {
          const prev = await models.ChangeLog.findOne({ tenantId, entityType: r.entityType, entityId: r.entityId, seq: { $lt: r.seq } })
            .sort({ seq: -1 })
            .select('detachmentId')
            .lean();
          return prev && prev.detachmentId && visibleSet.has(prev.detachmentId) ? r : null;
        }),
    );
    exits.filter(Boolean).forEach((r) => changes.push({ seq: r.seq, entityType: r.entityType, entityId: r.entityId, op: 'delete' }));
    changes.sort((a, b) => a.seq - b.seq);
  }

  const records = new Map();
  await Promise.all(
    [...toSerialize.entries()].map(async ([type, docs]) => {
      const map = await serializeType(type, docs, { tenantId, grant: ctx.grant, tz: ctx.tz });
      map.forEach((json, id) => records.set(`${type}:${id}`, json));
    }),
  );
  changes.forEach((c) => {
    if (c.op === 'upsert') c.record = records.get(`${c.entityType}:${c.entityId}`);
  });

  return { changes, nextCursor, hasMore, serverTime };
};

/** GET /sync/status */
const status = async (tenantId) => ({
  serverTime: new Date().toISOString(),
  latestSeq: await latestSeq(String(tenantId)),
  catalogue: catalogueKinds(),
});

module.exports = {
  CATALOGUE,
  ENTITY_TYPES,
  FEATURE_OF,
  registerKind,
  unregisterKind,
  catalogueKinds,
  buildOperationRequest,
  mapResponse,
  push,
  pull,
  status,
};
