/* eslint-disable no-console */
/**
 * `npm run postman:build` — compiles postman/modules/*.js into
 *   postman/Leader.postman_collection.json          (Postman v2.1)
 *   postman/Leader.local.postman_environment.json
 *
 * A module file exports:
 *   module.exports = {
 *     name: 'Tenant · Detachments',   // folder name
 *     order: 30,                       // folders sorted by order (auth first)
 *     description: 'markdown',
 *     items: [ Request, ... ],
 *   };
 *
 * Request (all keys optional except name/method/path):
 *   {
 *     name: 'Create detachment',
 *     method: 'POST',
 *     path: '/detachments',               // after /api/v1; may use {{vars}}
 *     auth: 'main' | 'simple' | 'platform' | 'onboarding' | 'demo' | 'none'
 *           | '{{someTokenVar}}',          // default 'main'
 *     query: { key: 'value' },
 *     headers: { 'X-Client-Version': '1.0.0' },
 *     idempotent: true,                    // adds Idempotency-Key: {{$guid}}
 *     body: { ... },                       // JSON body
 *     formData: [{ key: 'image', type: 'file', src: 'fixtures/sample.jpg' },
 *                { key: 'x', type: 'text', value: '1' }],
 *     expect: 201,                         // status assertion (number or [..])
 *     tests: ['pm.expect(json.name).to.eql("x")'],   // `json` is pre-parsed
 *     save: { detachmentId: 'json.id' },   // collection variables from JSON
 *     prerequest: ['pm.collectionVariables.set("x", Date.now())'],
 *     description: 'markdown shown in Postman',
 *     root: true,                          // path is NOT prefixed with /api/v1 (e.g. /health)
 *   }
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'postman');
const MODULES = path.join(ROOT, 'modules');

const TOKEN_VARS = {
  main: 'mainAdminToken',
  simple: 'simpleAdminToken',
  platform: 'platformToken',
  onboarding: 'onboardingToken',
  demo: 'demoToken',
};

const toScript = (lines) => (Array.isArray(lines) ? lines : [lines]).filter(Boolean);

const buildTests = (req) => {
  const exec = [
    'let json = null;',
    'try { json = pm.response.json(); } catch (e) { json = null; }',
  ];
  if (req.expect !== undefined) {
    const codes = Array.isArray(req.expect) ? req.expect : [req.expect];
    exec.push(
      `pm.test('status is ${codes.join(' or ')}', function () { pm.expect(${JSON.stringify(codes)}).to.include(pm.response.code, 'body: ' + pm.response.text().slice(0, 400)); });`,
    );
  }
  toScript(req.tests).forEach((line, i) => {
    exec.push(`pm.test(${JSON.stringify(`check ${i + 1}: ${line.slice(0, 70)}`)}, function () { ${line} });`);
  });
  Object.entries(req.save || {}).forEach(([name, expr]) => {
    exec.push(`try { const __v = ${expr}; if (__v !== undefined && __v !== null) pm.collectionVariables.set(${JSON.stringify(name)}, typeof __v === 'object' ? JSON.stringify(__v) : String(__v)); } catch (e) {}`);
  });
  return exec;
};

const buildRequest = (req) => {
  const headers = [];
  const auth = req.auth === undefined ? 'main' : req.auth;
  if (auth && auth !== 'none') {
    const token = TOKEN_VARS[auth] ? `{{${TOKEN_VARS[auth]}}}` : auth;
    headers.push({ key: 'Authorization', value: `Bearer ${token}` });
  }
  if (req.idempotent) headers.push({ key: 'Idempotency-Key', value: '{{$guid}}' });
  Object.entries(req.headers || {}).forEach(([key, value]) => headers.push({ key, value: String(value) }));

  const rawPath = req.path.startsWith('/') ? req.path : `/${req.path}`;
  const query = Object.entries(req.query || {}).map(([key, value]) => ({ key, value: String(value) }));
  const qs = query.length ? `?${query.map((q) => `${q.key}=${q.value}`).join('&')}` : '';
  const prefix = req.root ? '' : '/api/v1';
  const url = {
    raw: `{{baseUrl}}${prefix}${rawPath}${qs}`,
    host: ['{{baseUrl}}'],
    path: [...(req.root ? [] : ['api', 'v1']), ...rawPath.split('/').filter(Boolean)],
  };
  if (query.length) url.query = query;

  const request = { method: req.method.toUpperCase(), header: headers, url };
  if (req.description) request.description = req.description;
  if (req.formData) {
    request.body = {
      mode: 'formdata',
      formdata: req.formData.map((p) => (p.type === 'file' ? { key: p.key, type: 'file', src: p.src } : { key: p.key, type: 'text', value: String(p.value) })),
    };
  } else if (req.body !== undefined) {
    headers.push({ key: 'Content-Type', value: 'application/json' });
    request.body = { mode: 'raw', raw: JSON.stringify(req.body, null, 2), options: { raw: { language: 'json' } } };
  }

  const events = [{ listen: 'test', script: { type: 'text/javascript', exec: buildTests(req) } }];
  if (req.prerequest) events.unshift({ listen: 'prerequest', script: { type: 'text/javascript', exec: toScript(req.prerequest) } });
  return { name: req.name, event: events, request, response: [] };
};

const main = () => {
  const files = fs.existsSync(MODULES) ? fs.readdirSync(MODULES).filter((f) => f.endsWith('.js')) : [];
  const modules = files
    .map((f) => ({ file: f, ...require(path.join(MODULES, f)) }))
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.file.localeCompare(b.file));

  let requestCount = 0;
  const collection = {
    info: {
      name: 'Leader API',
      _postman_id: 'b6f1c0de-1ead-4e11-9a00-000000000001',
      description:
        'Leader / ليدر backend — every endpoint, runnable top-to-bottom against a seeded local database (`npm run seed`).\n\n' +
        'Run order matters: the first folder signs in the seeded accounts and stores their tokens in collection variables.\n' +
        'Full guide: backend/docs/FRONTEND-INTEGRATION-GUIDE.md',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: modules.map((m) => {
      requestCount += m.items.length;
      return { name: m.name, description: m.description || '', item: m.items.map(buildRequest) };
    }),
    variable: [
      { key: 'baseUrl', value: 'http://localhost:4000' },
      ...Object.values(TOKEN_VARS).map((key) => ({ key, value: '' })),
    ],
  };

  const environment = {
    id: 'b6f1c0de-1ead-4e11-9a00-000000000002',
    name: 'Leader — local',
    values: [
      { key: 'baseUrl', value: 'http://localhost:4000', enabled: true },
      { key: 'platformEmail', value: 'nullmod.dev@gmail.com', enabled: true },
      { key: 'mainAdminEmail', value: 'pbea4007@mtu.edu.iq', enabled: true },
      { key: 'simpleAdminEmail', value: 'hamodekaherhm@gmail.com', enabled: true },
      { key: 'seedPassword', value: 'Leader@12345', enabled: true },
    ],
    _postman_variable_scope: 'environment',
  };

  fs.writeFileSync(path.join(ROOT, 'Leader.postman_collection.json'), `${JSON.stringify(collection, null, 2)}\n`);
  fs.writeFileSync(path.join(ROOT, 'Leader.local.postman_environment.json'), `${JSON.stringify(environment, null, 2)}\n`);
  console.log(`Built ${modules.length} folders, ${requestCount} requests → postman/Leader.postman_collection.json`);
};

main();
