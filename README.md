# Leader / ليدر — backend

Node.js · Express 4 · MongoDB 7 (Mongoose 8). The API behind the Flutter app
in `../flutter_app`: identity & onboarding, the Super Admin control plane
(tenants, subscriptions, plans, features, Main Admin seats, audit, reports,
analytics, break-glass, Customer Demo, commerce) and the tenant plane
(detachment groups, detachments, members, shifts & attendance, inventory,
workshops, announcements, notifications, home, search, settings, analytics,
offline sync).

## Quick start

```bash
npm install
npm run db            # terminal 1: local MongoDB 7 replica set on 127.0.0.1:27017 (no install needed)
npm run seed:reset    # wipe + load demo data (see docs/FRONTEND-INTEGRATION-GUIDE.md §2)
npm run dev           # terminal 2: http://localhost:4000
```

`config.env` holds local settings (copy of `config.env.example`). Prefer your
own MongoDB or Docker? `docker compose up -d` (below) and keep the same
`MONGODB_URI`.

Sign in (password `Leader@12345` for every seeded account):

| Role | Email |
|---|---|
| Super Admin | nullmod.dev@gmail.com |
| Main Admin (saas_hilal) | pbea4007@mtu.edu.iq |
| Simple Admin (saas_hilal) | hamodekaherhm@gmail.com |

```bash
curl -s localhost:4000/api/v1/auth/sign-in -H 'Content-Type: application/json' \
  -d '{"email":"pbea4007@mtu.edu.iq","password":"Leader@12345"}'
```

## Scripts

| Script | Does |
|---|---|
| `npm run db` | Local persistent MongoDB (single-node replica set `rs0`, data in `.mongo-data/`) |
| `npm run seed` / `seed:reset` | Seed an empty DB / drop and reseed |
| `npm run dev` / `start` | API with nodemon / plain node |
| `npm test` | Jest + supertest against an in-memory MongoDB replica set |
| `npm run postman:build` | Compile `postman/modules/*.js` → `postman/Leader.postman_collection.json` |
| `npm run postman:run` | Run the whole collection with Newman against a running, freshly seeded server |

## Documentation

| File | For |
|---|---|
| [`docs/FRONTEND-INTEGRATION-GUIDE.md`](docs/FRONTEND-INTEGRATION-GUIDE.md) | The Flutter developer: concepts, flows, schemas, diagrams, Dart integration |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Backend developers: layout, conventions, auth chain, concurrency, tests |
| [`docs/api/`](docs/api) | Endpoint reference per module (every field, example and error code) |
| [`postman/`](postman) | Postman collection + local environment |

## Layout

```
app.js / server.js     Express app / boot
config/                env, wire vocabularies, the 30-key capability catalogue
models/                Mongoose schemas (prefixed string ids, version, change log)
routes/ controllers/   one router + controller set per module
validators/            Joi schemas
middlewares/           auth chain, idempotency, validation, uploads, version gate
services/              tokens, audit, email, limits, storage, serializers, seat rules…
jobs/                  background expiry jobs (demo sessions, break-glass, invitations)
seed/                  demo data (ids mirror the Flutter mocks)
public/images/         uploaded images, served at /images/...
tests/                 Jest suites
```

## Docker (optional)

```yaml
# docker-compose.yml is provided: MongoDB 7 as replica set rs0 on 27017
docker compose up -d
```
