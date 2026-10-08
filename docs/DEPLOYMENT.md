# Deployment

How the Leader API runs on the test server, how to update it, and how to roll
it back. No secret appears here: variables are named, never valued.

## Server layout (5.189.132.216)

| Item | Value |
|---|---|
| OS | Ubuntu 24.04 (LXC container) |
| SSH | port `22720` |
| API | port `22721`, plain HTTP, `PUBLIC_BASE_URL=http://5.189.132.216:22721` |
| Code | `/opt/leader/backend`, owner `leader` (no login shell) |
| Config | `/opt/leader/backend/config.env`, owner `leader`, mode `600`, server only |
| Service | systemd `leader-backend` — unit in [`deploy/leader-backend.service`](../deploy/leader-backend.service) |
| Database | `mongod` 7.0 on `127.0.0.1:22722`, auth + keyfile, replica set `rs0` (transactions) |
| DB secrets | `/root/.leader-secrets` (root, mode `600`) |

The code directory is a **`git archive` copy**: runtime folders only, no
`.git`, tests, docs or `node_modules`. "Which commit runs" is therefore
recorded in `/opt/leader/backend/DEPLOYED_COMMIT` by the update procedure
below, not read from git.

## Production `config.env`

Every variable is documented in [`config.env.example`](../config.env.example).
The ones that decide whether production is safe:

| Variable | Requirement |
|---|---|
| `NODE_ENV` | exactly `production`. Anything other than `development`/`test` switches off `DEV_FIXED_OTP`, `ALLOW_MOCK_GOOGLE` and `DEV_MAILBOX`. |
| `JWT_SECRET` | required outside development/test, 32+ characters, not a dev value — or the API refuses to boot. |
| `REFRESH_TOKEN_TTL_DAYS` | the absolute session lifetime. The app's offline copy trusts **7** days; a larger value means a session keeps working online after the phone stopped opening offline. |
| `MONGODB_URI` | the `leader_app` user on the `leader` database. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | without them no code email is delivered, so sign-up, reset and the returning-Google sign-in code cannot complete. |
| `GOOGLE_CLIENT_ID` | required for real Google sign-in. |
| `RATE_LIMIT_ENABLED` | `true`. |

Check a value's presence without printing it:

```bash
ssh -p 22720 root@5.189.132.216 \
  "awk -F= '/^[A-Z_]+=/{print \$1, (length(\$2) ? \"set\" : \"EMPTY\")}' /opt/leader/backend/config.env"
```

## Deploy order

1. **Backend first.** API changes are additive (for example `sessionId` in
   sign-in, refresh, onboarding and `/auth/me` answers), so older apps keep
   working.
2. Then build and install the app. An app talking to an older backend fails
   closed (for example: no offline restore until the server names the
   session).

## Pre-deploy checks (read-only, before every update)

```bash
REPO=~/Documents/Python-Files/flutter/apps/Leader_backend
HOST="-p 22720 root@5.189.132.216"
PATHS="app.js server.js package.json package-lock.json config controllers jobs middlewares models routes services utils validators seed"

# 1. Rollback target: which commit runs now (expected 67d170e before the sessionId release).
#    Older deploys have no DEPLOYED_COMMIT, so compare checksums with that commit's tree.
ssh $HOST 'cat /opt/leader/backend/DEPLOYED_COMMIT 2>/dev/null || echo "no DEPLOYED_COMMIT"'
rm -rf /tmp/leader-67d170e && mkdir /tmp/leader-67d170e
git -C "$REPO" archive 67d170e $PATHS | tar -x -C /tmp/leader-67d170e
(cd /tmp/leader-67d170e && find $PATHS -type f -exec sha256sum {} + | sort -k2) > /tmp/local.sums
ssh $HOST "cd /opt/leader/backend && find $PATHS -type f -exec sha256sum {} + | sort -k2" > /tmp/server.sums
diff -q /tmp/local.sums /tmp/server.sums && echo "server = 67d170e"

# 2. JWT_SECRET is 32+ characters (yes/no only). "no" = STOP: the new code refuses to boot.
ssh $HOST "awk 'index(\$0,\"JWT_SECRET=\")==1{v=substr(\$0,12); print (length(v)>=32 ? \"yes\" : \"no\")}' /opt/leader/backend/config.env"

# 3. Non-secret values to report: NODE_ENV (must be production) and REFRESH_TOKEN_TTL_DAYS.
#    Do not change REFRESH_TOKEN_TTL_DAYS without the owner's ruling (7 matches the app's offline window).
ssh $HOST "grep -E '^(NODE_ENV|REFRESH_TOKEN_TTL_DAYS)=' /opt/leader/backend/config.env"
```

## Update procedure (from the development machine)

```bash
REPO=~/Documents/Python-Files/flutter/apps/Leader_backend
HOST="-p 22720 root@5.189.132.216"
COMMIT=$(git -C "$REPO" rev-parse --short HEAD)

# 1. Package the committed tree (never the working tree).
rm -rf ~/Leader_deploy/server.new && mkdir ~/Leader_deploy/server.new
git -C "$REPO" archive HEAD app.js server.js package.json package-lock.json config controllers \
  jobs middlewares models routes services utils validators seed public | tar -x -C ~/Leader_deploy/server.new
cp ~/Leader_deploy/server/config.env.template ~/Leader_deploy/server.new/
echo "$COMMIT" > ~/Leader_deploy/server.new/DEPLOYED_COMMIT

# 2. Back up what runs now (rollback target), code only, config.env included.
ssh $HOST 'tar -C /opt/leader -czf /root/leader-backend-$(date -u +%Y%m%dT%H%M%SZ).tgz \
  --exclude=backend/node_modules --exclude="backend/public/images/*/" backend && ls -1t /root/leader-backend-*.tgz | head -1'

# 3. Sync (config.env and uploaded images stay on the server).
rsync -az --delete --exclude config.env --exclude node_modules --exclude 'public/images/*/' \
  -e "ssh -p 22720" ~/Leader_deploy/server.new/ root@5.189.132.216:/opt/leader/backend/

# 4. Install only if package.json / package-lock.json changed, then restart.
ssh $HOST 'chown -R leader:leader /opt/leader/backend && cd /opt/leader/backend && \
  runuser -u leader -- env HOME=/opt/leader npm ci --omit=dev && systemctl restart leader-backend'
# (no package change: ssh $HOST 'chown -R leader:leader /opt/leader/backend && systemctl restart leader-backend')
```

## Verify

```bash
curl -s http://5.189.132.216:22721/health                 # Mongo state ok
ssh -p 22720 root@5.189.132.216 'systemctl is-active leader-backend; journalctl -u leader-backend -n 20 --no-pager'
ssh -p 22720 root@5.189.132.216 'cat /opt/leader/backend/DEPLOYED_COMMIT'
# sessionId is present (shape only, no token printed): a wrong password must
# still be 401, and a demo start must list the new key.
curl -s -X POST http://5.189.132.216:22721/api/v1/auth/customer-demo/start \
  -H 'content-type: application/json' -d '{}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Object.keys(JSON.parse(s)).sort().join(",")))'
```

The demo start creates one throwaway `customer_demo` account and touches no
real account. Skip it when the demo is disabled.

## Rollback

```bash
BACKUP=/root/leader-backend-<timestamp>.tgz   # printed by step 2
ssh -p 22720 root@5.189.132.216 "systemctl stop leader-backend && \
  rm -rf /opt/leader/backend.failed && mv /opt/leader/backend /opt/leader/backend.failed && \
  tar -C /opt/leader -xzf $BACKUP && \
  chown -R leader:leader /opt/leader/backend && \
  runuser -u leader -- env HOME=/opt/leader sh -c 'cd /opt/leader/backend && npm ci --omit=dev' && \
  systemctl start leader-backend"
curl -s http://5.189.132.216:22721/health
```

Uploaded images live in `public/images/*/`; the backup excludes them and the
rollback keeps them in `backend.failed` — move them back if any were added.

## Reaching the API from a phone

- **Now (test):** a **debug** APK over HTTP:
  `flutter build apk --debug --dart-define=LEADER_API_BASE_URL=http://5.189.132.216:22721`.
  Cleartext is allowed only in `android/app/src/debug/AndroidManifest.xml`;
  release builds keep Android's cleartext block. Never enable cleartext in release.
- **HTTPS without a domain:** a Cloudflare quick tunnel on the server
  (`cloudflared tunnel --url http://127.0.0.1:22721`). Outbound only, valid
  certificate, so release builds work. The URL changes on every restart, so
  the app must be rebuilt each time.
- **Not possible without a domain:** Let's Encrypt for a bare IP — validation
  needs inbound 80/443.

## Traps

- **`trust proxy` is `false`** (`app.js`). Behind a tunnel or reverse proxy
  every client then looks like `127.0.0.1` and shares one IP rate-limit
  budget, and masked IPs in the session list are wrong. Set it to the proxy
  hop count only when a proxy is actually in front.
- **Email is not configured on the server.** Returning Google users get an
  email code and cannot finish without SMTP.
- **`REFRESH_TOKEN_TTL_DAYS`** above 7 makes online and offline lifetimes
  disagree (see above).
- **Offline sign-out** clears the phone only; the server session lives until
  its refresh lifetime ends.
