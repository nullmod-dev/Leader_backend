/**
 * The schema plugin every Leader model uses.
 *
 *  - `_id` is an opaque prefixed string (`d_01J…`), exposed as `id`.
 *  - `toJSON` drops `_id`, `__v` and (for tenant data) `tenantId`: a tenant
 *    session never needs to see the SaaS boundary it cannot choose.
 *  - `versioned: true` adds `version` (starts at 1, +1 on every modifying
 *    save) and makes `save()` conditional on the version it loaded — a
 *    concurrent writer loses with `DocumentNotFoundError`, which
 *    `services/versioning.js` turns into `409 stale_write`.
 *  - `changeLog: '<entityType>'` records every upsert/delete of a
 *    tenant-scoped document in `change_log` for `GET /sync/pull`.
 *  - tenant-scoped documents record `_createdByDevice` (the Device of the
 *    session that created them, from services/tenantContext; select:false,
 *    never serialized) so a restricted new device may edit its own records
 *    and no others (middlewares/restrictedSession).
 */
const { newId } = require('../../utils/ids');

function basePlugin(schema, options = {}) {
  const { prefix, versioned = false, changeLog = null, hideTenantId = true } = options;
  // Tenant-plane models (everything synced through the change log, plus any
  // model that opts in) get the data-layer isolation guard.
  const tenantScoped = options.tenantScoped ?? Boolean(changeLog);
  if (!prefix) throw new Error('basePlugin requires a prefix');

  schema.add({ _id: { type: String, default: () => newId(prefix) } });
  if (tenantScoped) {
    schema.plugin(require('./tenantScope'));
    schema.add({ _createdByDevice: { type: String, select: false } });
    schema.pre('save', function stampCreatingDevice(next) {
      if (this.isNew && !this._createdByDevice) {
        const ctx = require('../../services/tenantContext').get();
        if (ctx && ctx.deviceId) this._createdByDevice = ctx.deviceId;
      }
      next();
    });
  }

  if (versioned) {
    schema.add({ version: { type: Number, default: 1, min: 1 } });

    schema.pre('save', function versionBump(next) {
      if (this.isNew) {
        if (!this.version) this.version = 1;
        return next();
      }
      if (this.$__skipVersionBump) return next();
      const modified = this.modifiedPaths().filter((p) => p !== 'version' && p !== 'updatedAt');
      if (modified.length === 0) return next();
      const loaded = this.version;
      // Conditional save: only matches if nobody bumped the version meanwhile.
      this.$where = { ...(this.$where || {}), version: loaded };
      this.version = loaded + 1;
      return next();
    });
  }

  schema.set('toJSON', {
    virtuals: true,
    versionKey: false,
    transform(doc, ret) {
      ret.id = ret._id;
      delete ret._id;
      delete ret.__v;
      if (hideTenantId) delete ret.tenantId;
      // Internal search/uniqueness helpers never leave the server.
      Object.keys(ret).forEach((k) => {
        if (k.startsWith('_') || k.endsWith('Key') || k.endsWith('Hash')) delete ret[k];
      });
      return ret;
    },
  });
  schema.set('toObject', { virtuals: true, versionKey: false });
  schema.set('id', false);

  if (changeLog) {
    // Lazy requires avoid a model-registration cycle.
    const record = async (doc, op) => {
      if (!doc || !doc.tenantId) return;
      const Counter = require('../counterModel');
      const ChangeLog = require('../changeLogModel');
      const session = doc.$session ? doc.$session() : undefined;
      const seq = await Counter.next(`changelog:${doc.tenantId}`, session);
      await ChangeLog.create(
        [
          {
            tenantId: doc.tenantId,
            seq,
            entityType: changeLog,
            entityId: doc._id,
            op,
            version: doc.version,
            detachmentId: doc.detachmentId,
          },
        ],
        { session },
      );
    };

    schema.post('save', async function afterSave(doc) {
      await record(doc, 'upsert');
    });
    schema.post('deleteOne', { document: true, query: false }, async function afterDelete(doc) {
      await record(doc, 'delete');
    });
  }
}

module.exports = basePlugin;
