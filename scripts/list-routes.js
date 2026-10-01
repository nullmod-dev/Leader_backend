/* eslint-disable no-console */
/**
 * `node scripts/list-routes.js [--json] [--coverage]`
 *
 * Prints every HTTP endpoint the app actually serves, read from Express's own
 * router stack (so it can never drift from the code). With `--coverage`, also
 * reports which endpoints the Postman collection exercises.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'config.env') });
process.env.JOBS_ENABLED = 'false';

const app = require('../app');

const regexpToPath = (layer) => {
  if (layer.route) return layer.route.path;
  if (!layer.regexp || layer.regexp.fast_slash) return '';
  let src = layer.regexp.source
    .replace('^\\/', '/')
    .replace('\\/?(?=\\/|$)', '')
    .replace(/\\\//g, '/')
    .replace(/\(\?:\/\(\[\^\/\]\+\?\)\)/g, '/:param')
    .replace(/\(\?:\(\[\^\\\/]\+\?\)\)/g, ':param');
  (layer.keys || []).forEach((k) => {
    src = src.replace(':param', `:${k.name}`);
  });
  return src.replace(/\$$/, '').replace(/\/\?$/, '');
};

const walk = (stack, prefix, out) => {
  stack.forEach((layer) => {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).filter((m) => m !== '_all').map((m) => m.toUpperCase());
      const p = `${prefix}${layer.route.path}`.replace(/\/+/g, '/');
      methods.forEach((method) => out.push({ method, path: p.length > 1 ? p.replace(/\/$/, '') : p }));
    } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      walk(layer.handle.stack, `${prefix}${regexpToPath(layer)}`, out);
    }
  });
};

const routes = [];
walk(app._router.stack, '', routes);
const unique = [...new Map(routes.map((r) => [`${r.method} ${r.path}`, r])).values()].filter((r) => r.path !== '*');
unique.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(unique, null, 2));
} else if (process.argv.includes('--coverage')) {
  const collection = require('../postman/Leader.postman_collection.json');
  const hits = [];
  const collect = (items) =>
    items.forEach((it) => {
      if (it.item) collect(it.item);
      else hits.push({ method: it.request.method, path: `/${it.request.url.path.join('/')}` });
    });
  collect(collection.item);
  const matches = (route, hit) => {
    if (route.method !== hit.method) return false;
    const rs = route.path.split('/').filter(Boolean);
    const hs = hit.path.split('/').filter(Boolean);
    if (rs.length !== hs.length) return false;
    return rs.every((seg, i) => seg.startsWith(':') || seg === hs[i] || /^\{\{.*\}\}$/.test(hs[i]) && seg.startsWith(':'));
  };
  const covered = unique.filter((r) => hits.some((h) => matches(r, h)));
  const missing = unique.filter((r) => !covered.includes(r));
  console.log(`endpoints: ${unique.length} · covered by Postman: ${covered.length} · not covered: ${missing.length}`);
  missing.forEach((r) => console.log(`  - ${r.method.padEnd(6)} ${r.path}`));
} else {
  unique.forEach((r) => console.log(`${r.method.padEnd(6)} ${r.path}`));
  console.log(`\n${unique.length} endpoints`);
}
process.exit(0);
