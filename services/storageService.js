/**
 * Local image storage under `public/images/<folder>/` (no R2/S3 for now).
 *
 * Every image is re-encoded with sharp (resized, EXIF stripped, WebP) — the
 * original upload is never written to disk. Files are served statically at
 * `/images/...`; the API returns absolute URLs built from PUBLIC_BASE_URL.
 *
 * Each write is recorded in `stored_files` and counted in the tenant's
 * `storage_bytes` usage, and checked against the plan limit BEFORE writing.
 */
const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const { StoredFile, SaasTenant } = require('../models');
const { ulid } = require('../utils/ids');
const usageService = require('./usageService');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const IMAGES_DIR = path.join(PUBLIC_DIR, 'images');

/** Named presets: folder + resize box. */
const PRESETS = {
  avatar: { folder: 'avatars', width: 512, height: 512, fit: 'cover' },
  member: { folder: 'members', width: 512, height: 512, fit: 'cover' },
  detachment: { folder: 'detachments', width: 1280, height: 720, fit: 'cover' },
  inventory: { folder: 'inventory', width: 800, height: 800, fit: 'inside' },
  workshop: { folder: 'workshops', width: 1600, height: 900, fit: 'cover' },
  tenantLogo: { folder: 'tenants', width: 512, height: 512, fit: 'contain' },
};

const absoluteOf = (publicPath) => path.join(PUBLIC_DIR, ...publicPath.replace(/^\/+/, '').split('/'));

/**
 * Encode + write an image.
 * @param {Buffer} buffer    raw upload
 * @param {string} presetName key of PRESETS
 * @param {object} owner     { ownerType, ownerId, tenantId? }
 * @returns {Promise<{ path: string, bytes: number }>}
 */
const saveImage = async (buffer, presetName, { ownerType, ownerId, tenantId = null }) => {
  const preset = PRESETS[presetName];
  if (!preset) throw new Error(`unknown image preset ${presetName}`);

  const output = await sharp(buffer, { failOn: 'error' })
    .rotate() // honour EXIF orientation, then EXIF is dropped
    .resize(preset.width, preset.height, { fit: preset.fit, withoutEnlargement: true, background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .webp({ quality: 82 })
    .toBuffer();

  if (tenantId) {
    const tenant = await SaasTenant.findById(tenantId);
    if (tenant) await usageService.assertCanConsume(tenant, 'storage_bytes', output.length);
  }

  const fileName = `${ownerType}-${String(ownerId).replace(/[^a-zA-Z0-9_-]/g, '')}-${ulid().toLowerCase()}.webp`;
  const dir = path.join(IMAGES_DIR, preset.folder);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, fileName), output);

  const publicPath = `/images/${preset.folder}/${fileName}`;
  await StoredFile.create({ tenantId, ownerType, ownerId: String(ownerId), path: publicPath, bytes: output.length, mime: 'image/webp' });
  if (tenantId) {
    await SaasTenant.updateOne({ _id: tenantId }, { $inc: { 'usage.storageUsedBytes': output.length } });
  }
  return { path: publicPath, bytes: output.length };
};

/** Delete a stored file (disk + ledger + usage). Missing files are ignored. */
const removeFile = async (publicPath) => {
  if (!publicPath) return;
  const rec = await StoredFile.findOneAndDelete({ path: publicPath });
  try {
    await fs.unlink(absoluteOf(publicPath));
  } catch (e) {
    /* already gone */
  }
  if (rec && rec.tenantId) {
    await SaasTenant.updateOne({ _id: rec.tenantId }, { $inc: { 'usage.storageUsedBytes': -rec.bytes } });
  }
};

/** Remove every file an owner has (used when the owner itself is deleted). */
const removeOwnerFiles = async (ownerType, ownerId) => {
  const files = await StoredFile.find({ ownerType, ownerId: String(ownerId) });
  for (const f of files) await removeFile(f.path);
};

/** Remove every file of a tenant (final deletion). */
const removeTenantFiles = async (tenantId) => {
  const files = await StoredFile.find({ tenantId });
  for (const f of files) await removeFile(f.path);
};

module.exports = { saveImage, removeFile, removeOwnerFiles, removeTenantFiles, PRESETS, IMAGES_DIR, PUBLIC_DIR };
