/**
 * Opaque, prefixed, time-sortable ids: `<prefix>_<ULID>`.
 *
 * The client never parses an id (BACKEND-HANDOFF.md §2) — the prefix is only
 * there to make logs and Mongo shells readable. ULIDs sort by creation time,
 * which makes `_id` a stable secondary sort key for cursors.
 */
const crypto = require('crypto');

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let lastTime = 0;
let lastRandom = null;

const encodeTime = (time) => {
  let out = '';
  let t = time;
  for (let i = 0; i < 10; i += 1) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
};

const randomChars = () => {
  const bytes = crypto.randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i += 1) out += CROCKFORD[bytes[i] % 32];
  return out;
};

// Monotonic within the same millisecond so ids created in one tick still sort.
const incrementRandom = (str) => {
  const chars = str.split('');
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const idx = CROCKFORD.indexOf(chars[i]);
    if (idx < 31) {
      chars[i] = CROCKFORD[idx + 1];
      return chars.join('');
    }
    chars[i] = CROCKFORD[0];
  }
  return chars.join('');
};

const ulid = () => {
  const now = Date.now();
  if (now === lastTime && lastRandom) {
    lastRandom = incrementRandom(lastRandom);
  } else {
    lastTime = now;
    lastRandom = randomChars();
  }
  return encodeTime(now) + lastRandom;
};

const newId = (prefix) => `${prefix}_${ulid()}`;

/** RFC 9562 UUIDv7 — the format the Flutter outbox mints for Idempotency-Key. */
const uuidV7 = () => {
  const bytes = crypto.randomBytes(16);
  const ts = BigInt(Date.now());
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

module.exports = { ulid, newId, uuidV7, randomToken, sha256 };
