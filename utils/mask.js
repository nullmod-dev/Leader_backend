/** Masking at source — the server never sends these values in clear. */

/** "+963 912 345 123" → "+963 9xx xxx 123" (keep country prefix + first + last 3 digits). */
const phone = (value) => {
  if (!value) return undefined;
  const digits = String(value).replace(/[^\d+]/g, '');
  if (digits.length < 6) return 'x'.repeat(digits.length);
  const hasPlus = digits.startsWith('+');
  const body = hasPlus ? digits.slice(1) : digits;
  const cc = hasPlus ? body.slice(0, 3) : '';
  const rest = hasPlus ? body.slice(3) : body;
  const first = rest.slice(0, 1);
  const last = rest.slice(-3);
  const middle = rest.slice(1, -3).replace(/\d/g, 'x');
  const grouped = `${first}${middle}`.replace(/(.{3})(?=.)/g, '$1 ');
  return `${hasPlus ? `+${cc} ` : ''}${grouped} ${last}`.replace(/\s+/g, ' ').trim();
};

/** "salma@hilal.org" → "s***@hilal.org". */
const email = (value) => {
  if (!value || !String(value).includes('@')) return '***';
  const [local, domain] = String(value).split('@');
  return `${local.slice(0, 1)}***@${domain}`;
};

/** IPv4 → "192.0.xx.xx"; IPv6 → first two groups + "::xx". */
const ip = (value) => {
  if (!value) return 'unknown';
  const v = String(value).replace(/^::ffff:/, '');
  if (v.includes('.')) {
    const parts = v.split('.');
    return `${parts[0]}.${parts[1]}.xx.xx`;
  }
  const groups = v.split(':').filter(Boolean);
  return `${groups.slice(0, 2).join(':')}::xx`;
};

module.exports = { phone, email, ip };
