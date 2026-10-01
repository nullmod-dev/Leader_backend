/**
 * Normalization shared with the Flutter client. Each function here has a Dart
 * twin; the two must reach the same string or matching silently breaks.
 */
const { TEAM_CODE_ALPHABET } = require('../config/constants');

/** Trim + collapse internal whitespace (normalizeMemberName, reasons, names). */
const collapse = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');

/** Lower-cased collapsed key used for uniqueness (memberNameKey). */
const nameKey = (value) => collapse(value).toLowerCase();

/** Email: trim + lowercase. No Gmail dot/plus folding. */
const email = (value) => String(value ?? '').trim().toLowerCase();

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const isEmail = (value) => EMAIL_RE.test(email(value)) && email(value).length <= 254;

/** Initials: the first character of each of the first two words. */
const initialsOf = (name) => {
  const words = collapse(name).split(' ').filter(Boolean);
  return words
    .slice(0, 2)
    .map((w) => Array.from(w)[0])
    .join('')
    .toUpperCase();
};

/** Arabic-Indic and Eastern Arabic-Indic digits → ASCII. */
const foldDigits = (value) =>
  String(value ?? '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));

/**
 * Search folding for Arabic + Latin text: strip diacritics/tatweel, fold
 * alef/ya/waw/ta-marbuta variants, fold digits, lowercase.
 */
const searchFold = (value) =>
  foldDigits(value)
    .normalize('NFKD')
    .replace(/[ً-ٰٟـ]/g, '') // harakat, superscript alef, tatweel
    .replace(/[آأإٱ]/g, 'ا') // alef variants → ا
    .replace(/ى/g, 'ي') // alef maqsura → ya
    .replace(/ؤ/g, 'و') // waw hamza → waw
    .replace(/ئ/g, 'ي') // ya hamza → ya
    .replace(/ة/g, 'ه') // ta marbuta → ha
    .replace(/[̀-ͯ]/g, '') // latin combining marks
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- Team Code -------------------------------------------------------------

/** Canonical form of a typed Team Code: `MTM-XXXX-XXXX` (prefix optional on input). */
const normalizeTeamCode = (value) => {
  let raw = foldDigits(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (raw.startsWith('MTM')) raw = raw.slice(3);
  if (raw.length !== 8) return null;
  if (![...raw].every((ch) => TEAM_CODE_ALPHABET.includes(ch))) return null;
  return `MTM-${raw.slice(0, 4)}-${raw.slice(4)}`;
};

const generateTeamCode = () => {
  const crypto = require('crypto');
  const bytes = crypto.randomBytes(8);
  let body = '';
  for (let i = 0; i < 8; i += 1) body += TEAM_CODE_ALPHABET[bytes[i] % TEAM_CODE_ALPHABET.length];
  return `MTM-${body.slice(0, 4)}-${body.slice(4)}`;
};

// ---- coupon codes (PRICING-PROMOTIONS-ARCHITECTURE) --------------------------
const normalizeCouponCode = (value) => {
  const code = String(value ?? '').trim().replace(/\s+/g, '').toUpperCase();
  return /^[A-Z0-9-]{3,24}$/.test(code) ? code : null;
};

/** Reasons: collapse, required, ≤ max. Returns null when invalid. */
const reason = (value, max = 280) => {
  const r = collapse(value);
  if (!r || r.length > max) return null;
  return r;
};

module.exports = {
  collapse,
  nameKey,
  email,
  isEmail,
  initialsOf,
  foldDigits,
  searchFold,
  escapeRegex,
  normalizeTeamCode,
  generateTeamCode,
  normalizeCouponCode,
  reason,
};
