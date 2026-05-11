# ProtectiveShell Operations Guide

This guide explains how to deploy ProtectiveShell and how to configure every runtime option that currently exists in the project.

ProtectiveShell is a single Node.js application that serves both the Express API and the React frontend. It requires PostgreSQL, stores sessions in PostgreSQL, and can run background workers for expected backup runs, IMAP ingestion, Proxmox checks, backup target polling, and SMTP incident notifications.

## Deployment Model

ProtectiveShell runs as one process:

```text
Browser
  -> HTTP(S) reverse proxy, recommended for production
  -> ProtectiveShell Node process
  -> PostgreSQL
  -> monitored infrastructure, optional
       - IMAP server
       - SMTP server
       - Proxmox hosts over SSH
       - Synology DSM / Proxmox Backup Server over HTTPS
```

The app listens on one HTTP port, `5000` by default. In production, put it behind HTTPS with a reverse proxy such as Nginx, Caddy, Traefik, IIS ARR, or a platform load balancer.

## Requirements

- Node.js `20` through `25`
- npm `10` or newer
- PostgreSQL
- Network reachability from the app server to the systems you want to monitor
- A stable `SECRET_ENCRYPTION_KEY`
- A stable `SESSION_SECRET`

The `package.json` engine range is `>=20 <26`. Node 20 or 22 LTS is the safest production choice.

## Important Build Note

`npm run build` uses Vite and esbuild. These tools spawn helper processes. On locked-down Windows environments, PowerShell policy or endpoint protection can block that subprocess with `spawn EPERM`. The code can still type-check and test, but a production bundle requires an environment where Node can spawn esbuild.

Production builds intentionally leave out development-only Vite helper plugins such as the runtime error overlay. Replit helper plugins remain development-only.

Recommended production build environments:

- Linux server or CI runner
- Windows host where Node child processes are allowed
- Node 20 or 22 LTS

If `npm run build` fails with `spawn EPERM`, fix the host policy or build on CI/Linux and deploy the produced `dist/` folder.

## Quick Local Run

1. Install dependencies:

```powershell
npm install
```

2. Create a local `.env`:

```powershell
Copy-Item .env.example .env
```

3. Edit `.env` and set `DATABASE_URL`, `SESSION_SECRET`, `SECRET_ENCRYPTION_KEY`, and admin login values.

4. Apply the database schema:

```powershell
npm.cmd run db:push
```

5. Start development mode:

```powershell
npm.cmd run dev
```

6. Open:

```text
http://localhost:5000
```

Development mode seeds sample data automatically when the database has no customers. Production does not seed unless `SEED_ON_BOOT=1`.

## Production Deployment

1. Prepare PostgreSQL.

Create a database and a user with permission to create and alter tables in that database. The app currently uses Drizzle `push`, so the deployment user must be allowed to apply schema changes.

Example connection string:

```env
DATABASE_URL=postgres://protectiveshell:strong-password@db.internal:5432/protectiveshell
```

2. Install dependencies.

```powershell
npm ci
```

3. Create `.env`.

Use `.env.example` as the starting point. For production, set at least:

```env
NODE_ENV=production
PORT=5000
DATABASE_URL=postgres://protectiveshell:strong-password@db.internal:5432/protectiveshell
SESSION_SECRET=replace-with-random-secret
SECRET_ENCRYPTION_KEY=replace-with-stable-32-byte-random-key
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-strong-password
TRUST_PROXY=1
COOKIE_SECURE=1
```

Generate good secrets with Node:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Use one value for `SESSION_SECRET` and a different value for `SECRET_ENCRYPTION_KEY`.

4. Apply schema changes.

```powershell
npm.cmd run db:push
```

Back up production data before running schema changes.

5. Build.

```powershell
npm.cmd run build
```

6. Start.

```powershell
npm.cmd start
```

7. Put a reverse proxy in front.

ProtectiveShell should be exposed through HTTPS. The reverse proxy should forward:

- `Host`
- `X-Forwarded-Host`
- `X-Forwarded-Proto`
- `X-Forwarded-For`

When behind a trusted proxy, set:

```env
TRUST_PROXY=1
COOKIE_SECURE=1
```

## Example Nginx Reverse Proxy

```nginx
server {
  listen 443 ssl http2;
  server_name protectiveshell.example.com;

  ssl_certificate /etc/letsencrypt/live/protectiveshell.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/protectiveshell.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:5000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

## Example systemd Unit

```ini
[Unit]
Description=ProtectiveShell
After=network.target postgresql.service

[Service]
Type=simple
WorkingDirectory=/opt/protectiveshell
EnvironmentFile=/opt/protectiveshell/.env
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
User=protectiveshell
Group=protectiveshell

[Install]
WantedBy=multi-user.target
```

After creating the unit:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now protectiveshell
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Starts the app in development mode with Vite middleware. |
| `npm run build` | Builds the React frontend into `dist/public` and bundles the server into `dist/index.cjs`. |
| `npm start` | Starts the production server from `dist/index.cjs`. |
| `npm run check` | Runs TypeScript type checking. |
| `npm test` | Runs focused server and client regression tests, including health response behavior and UI workflow payload builders. |
| `npm run verify` | Runs type checking and tests. |
| `npm run db:push` | Applies the Drizzle schema to the configured PostgreSQL database. |
| `npm run db:generate` | Generates tracked Drizzle migration files. |
| `npm run db:migrate` | Applies tracked Drizzle migrations. |
| `npm run admin:hash-password -- "password"` | Generates an `ADMIN_PASSWORD_HASH` value. |

On native Windows PowerShell, use `npm.cmd` if script execution policy blocks `npm.ps1`:

```powershell
npm.cmd run verify
```

## Configuration Sources And Precedence

There are two configuration sources:

- Environment variables in `.env`
- Database-backed app settings edited in the Settings page or via `/api/settings`

For settings used by workers, database settings usually override environment variables. The major exception is scheduler interval values such as `PROXMOX_POLL_INTERVAL_MINUTES`, which are read from environment at startup.

Secret-like setting keys ending in `PASS`, `PASSWORD`, `SECRET`, `TOKEN`, `PRIVATE_KEY`, or `API_KEY` are encrypted before storage and returned blank to the UI. Leaving a secret field blank in Settings preserves the existing stored value. Use the clear action next to a secret field to remove the stored value.

## Environment Variables

### App Runtime

| Variable | Default | Required | Restart needed | Description |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | `development` if omitted by scripts | Production: yes | Yes | Controls production behavior. In production, required secrets are enforced and static files are served from `dist/public`. |
| `PORT` | `5000` | No | Yes | HTTP port used by the Node process. |
| `APP_TIMEZONE` | `UTC` fallback | Recommended | Scheduler reads DB/env during run | Default timezone for expected backup run calculations and daily reports. Can be overridden by Settings `APP_TIMEZONE`. Use an IANA name such as `America/Phoenix`; invalid values fall back to `UTC`. |
| `DATABASE_URL` | none | Yes | Yes | PostgreSQL connection string. The app will not boot without it. |
| `SEED_ON_BOOT` | `0` in production | No | Yes | When `1`, seeds demo data if the database has no customers. Development mode also seeds automatically. |
| `DISABLE_SCHEDULER` | `0` | No | Yes | When `1`, disables all background workers. Useful for migrations, maintenance, or running a second web-only instance. |

### Sessions And Admin Login

| Variable | Default | Required | Restart needed | Description |
| --- | --- | --- | --- | --- |
| `SESSION_SECRET` | development fallback only | Production: yes | Yes | Signs session cookies. Changing it logs out existing sessions. |
| `ADMIN_USERNAME` | `admin` | No | Yes | Admin login username. |
| `ADMIN_PASSWORD` | development fallback `admin` | Production: yes unless hash set | Yes | Plain admin password read from environment. Prefer strong random values. |
| `ADMIN_PASSWORD_HASH` | none | Production: yes unless password set | Yes | Optional `scrypt:` password hash. Takes precedence over `ADMIN_PASSWORD`. |
| `TRUST_PROXY` | `0` | Required behind proxy | Yes | Set to `1` only when the app is behind a trusted reverse proxy. Enables Express proxy trust and forwarded-host origin checks. |
| `COOKIE_SECURE` | `0`, or production with trusted proxy | Recommended in production | Yes | When `1`, session cookies require HTTPS. Set when served behind HTTPS. |
| `LOGIN_RATE_LIMIT_MAX` | `8` | No | Yes | Maximum login attempts per IP in a 15-minute window. |

In production, the server sends HSTS when `COOKIE_SECURE=1` or `TRUST_PROXY=1`.

### Secret Encryption

| Variable | Default | Required | Restart needed | Description |
| --- | --- | --- | --- | --- |
| `SECRET_ENCRYPTION_KEY` | development fallback, or `SESSION_SECRET` fallback | Production: yes | Yes | Encrypts stored target passwords and secret app settings. Must stay stable for the life of the database. Accepts 32-byte base64, 32-byte hex, or arbitrary material hashed to 32 bytes. |

Changing `SECRET_ENCRYPTION_KEY` after secrets have been stored can make existing encrypted values undecryptable. Rotate it only with a planned migration.

### Scheduler Intervals

| Variable | Default | Required | Restart needed | Description |
| --- | --- | --- | --- | --- |
| `PROXMOX_POLL_INTERVAL_MINUTES` | `5` | No | Yes | How often enabled Proxmox hosts are checked. |
| `BACKUP_TARGET_POLL_INTERVAL_MINUTES` | `30` | No | Yes | How often enabled backup targets are polled for capacity. |
| `IMAP_POLL_INTERVAL_MINUTES` | `60` | No | Yes | How often the IMAP worker checks for new mail. |

The expected-run producer runs every 15 minutes. Deadline evaluation runs every minute. Incident notification delivery runs every 5 minutes. Those intervals are currently fixed in code.

### IMAP

These values can be configured either as environment variables or database-backed Settings. The IMAP worker requires `IMAP_HOST`, `IMAP_USER`, and `IMAP_PASS`.

| Variable / setting | Default | Required | Restart needed | Description |
| --- | --- | --- | --- | --- |
| `IMAP_HOST` | none | For IMAP polling | No, if set in Settings | IMAP server hostname. |
| `IMAP_PORT` | `993` | No | No, if set in Settings | IMAP server port. |
| `IMAP_USER` | none | For IMAP polling | No, if set in Settings | Login username, usually an email address. |
| `IMAP_PASS` | none | For IMAP polling | No, if set in Settings | Login password or app password. Encrypted when stored in Settings. |
| `IMAP_FOLDER` | `INBOX` | No | No, if set in DB/API | Folder to select. Not currently exposed in the Settings UI. |
| `IMAP_TLS` | `1` | No | No, if set in DB/API | `1` uses TLS. Set `0` only for a trusted internal plaintext IMAP endpoint. Not currently exposed in the Settings UI. |
| `IMAP_FETCH_LIMIT` | `50`, max `200` | No | No, if set in DB/API | Maximum new messages fetched per poll. Not currently exposed in the Settings UI. |
| `IMAP_POLL_INTERVAL` | none | No | No | Displayed in the Settings UI, but the active worker interval is `IMAP_POLL_INTERVAL_MINUTES` from environment. Treat this as reserved until wired into the scheduler. |

Use the Settings page `Test` button on the IMAP tab to validate host, login, and folder selection.

### SMTP

These values can be configured either as environment variables or database-backed Settings. Notification delivery requires `SMTP_HOST`, `SMTP_FROM`, and at least one enabled recipient.

| Variable / setting | Default | Required | Restart needed | Description |
| --- | --- | --- | --- | --- |
| `SMTP_HOST` | none | For notifications | No, if set in Settings | SMTP server hostname. |
| `SMTP_PORT` | `587` | No | No, if set in Settings | SMTP server port. Port `465` is treated as implicit TLS. |
| `SMTP_USER` | none | Depends on SMTP server | No, if set in Settings | SMTP auth username. |
| `SMTP_PASS` | none | Depends on SMTP server | No, if set in Settings | SMTP auth password. Encrypted when stored in Settings. |
| `SMTP_FROM` | none | For notifications | No, if set in Settings | Sender address used in notification emails. |
| `SMTP_STARTTLS` | `1` | No | No, if set in DB/API | Enables STARTTLS on non-465 SMTP ports. Set `0` only for trusted internal SMTP. Not currently exposed in the Settings UI. |

Use the Settings page `Test` button on the SMTP tab to validate connection and authentication.

### Target TLS And SSH Escape Hatches

| Variable | Default | Required | Restart needed | Description |
| --- | --- | --- | --- | --- |
| `ALLOW_INSECURE_TARGET_TLS` | `0` | No | Yes | Global escape hatch allowing self-signed or unverified HTTPS target certificates. Prefer per-target TLS fingerprints. Production also requires `ALLOW_PRODUCTION_INSECURE_TARGETS=1`. |
| `ALLOW_INSECURE_SSH_HOST_KEYS` | `0` | No | Yes | Global escape hatch allowing unknown SSH host keys. Prefer per-host SSH fingerprints. Production also requires `ALLOW_PRODUCTION_INSECURE_TARGETS=1`. |
| `ALLOW_PRODUCTION_INSECURE_TARGETS` | `0` | No | Yes | Explicit production override required before insecure target TLS or SSH bypasses are accepted. |
| `MONITORED_TARGET_ALLOW_CIDRS` | none | No | Yes | Optional comma-separated CIDR allowlist for monitored target host addresses. |

Use these only in isolated development or while enrolling fingerprints. For production, pin fingerprints per target or host.

When a backup target TLS fingerprint is configured, ProtectiveShell validates it during the TLS handshake before sending target credentials.

Monitored Proxmox and backup target hosts are resolved before save and before polling. Loopback, link-local, multicast, unspecified, and metadata service addresses are blocked. Private LAN addresses are allowed by default, but `MONITORED_TARGET_ALLOW_CIDRS` can be used to restrict monitoring to a known set of internal ranges.

### Development / Platform

| Variable | Default | Required | Restart needed | Description |
| --- | --- | --- | --- | --- |
| `REPL_ID` | none | No | Yes | When present in development, enables Replit Vite helper plugins. Not needed for ordinary deployment. |

## Database-Backed Settings

The Settings page writes to the `app_settings` table. Secret values are encrypted before storage.

| Setting key | Used today | Description |
| --- | --- | --- |
| `APP_TIMEZONE` | Yes | Timezone used by expected-run scheduling and daily report due checks. Overrides environment `APP_TIMEZONE`; invalid values fall back to `UTC`. |
| `IMAP_HOST` | Yes | IMAP hostname. |
| `IMAP_PORT` | Yes | IMAP port. |
| `IMAP_USER` | Yes | IMAP username. |
| `IMAP_PASS` | Yes | IMAP password, encrypted. |
| `IMAP_FOLDER` | Yes | IMAP folder, default `INBOX`. API/env only unless added manually. |
| `IMAP_TLS` | Yes | `1` for TLS, `0` for plaintext. API/env only unless added manually. |
| `IMAP_FETCH_LIMIT` | Yes | Maximum messages per IMAP poll. API/env only unless added manually. |
| `IMAP_POLL_INTERVAL` | Yes | IMAP polling interval in minutes. Loaded when the scheduler starts. Environment `IMAP_POLL_INTERVAL_MINUTES` remains the fallback. |
| `SMTP_HOST` | Yes | SMTP hostname. |
| `SMTP_PORT` | Yes | SMTP port. |
| `SMTP_USER` | Yes | SMTP username. |
| `SMTP_PASS` | Yes | SMTP password, encrypted. |
| `SMTP_FROM` | Yes | Notification sender address. |
| `SMTP_STARTTLS` | Yes | `1` enables STARTTLS on non-465 ports. API/env only unless added manually. |
| `CONSECUTIVE_FAILURE_THRESHOLD` | Yes | Number of failed Proxmox checks before an unreachable incident is opened. Defaults to `3`. |
| `RETENTION_DAYS` | Yes | Retention worker deletes old emails, events, expected runs, Proxmox checks, and non-open incidents after this many days. Defaults to `90`. |
| `SSH_TIMEOUT` | Yes | SSH collector timeout in seconds. Defaults to `20`. |
| `DAILY_REPORT_TIME` | Yes | Sends a daily operational summary at this local `HH:MM` time when SMTP and recipients are configured. |

## Admin Authentication

The app has one admin identity. The username comes from `ADMIN_USERNAME`; the password is verified from `ADMIN_PASSWORD_HASH` if present, otherwise `ADMIN_PASSWORD`.

Production boot rules:

- `SESSION_SECRET` must be set.
- Either `ADMIN_PASSWORD` or `ADMIN_PASSWORD_HASH` must be set.
- `SECRET_ENCRYPTION_KEY` must be set.

Sessions are stored in the `user_sessions` PostgreSQL table. The table is created automatically by `connect-pg-simple` if missing.

## Security Headers And Cross-Site Protection

The server sets:

- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: same-origin`
- `X-Frame-Options: DENY`
- `Permissions-Policy` blocking camera, microphone, and geolocation
- Production Content Security Policy

Mutating `/api` requests reject cross-site origins. When `TRUST_PROXY=1`, forwarded host headers are accepted from the trusted proxy. Do not set `TRUST_PROXY=1` when the app is directly exposed to untrusted clients.

Readiness diagnostics are also environment-aware. `/readyz` includes database and scheduler detail outside production, but in production it only returns the top-level `{ ok }` value to avoid exposing operational internals through a public health endpoint.

## Operator Safeguards And Payload Contracts

Destructive UI actions use confirmation dialogs instead of browser-native prompts. Deleting customers, jobs, recipients, notification routes, Proxmox hosts, and backup targets presents the operator with the specific consequence before the mutation runs.

Client form workflows share request-payload builders in `client/src/lib/workflow-payloads.ts`. These normalize optional select values, numeric defaults, secret-preserving edit behavior, email linking payloads, settings updates, recipients, and notification routes. The builders are covered by regression tests so UI refactors are less likely to drift from API expectations.

Monitoring JSON payloads use shared Zod schemas in `shared/monitoringPayloads.ts`. The frontend parses Proxmox health and backup datastore payloads through those schemas before rendering, which keeps partial or unexpected collector data from leaking directly into display logic.

## Background Workers

All workers run inside the main Node process unless `DISABLE_SCHEDULER=1`.

| Worker | Interval | What it does |
| --- | --- | --- |
| Proxmox polling | `PROXMOX_POLL_INTERVAL_MINUTES`, default `5` | SSHes into enabled Proxmox hosts and stores health checks. Opens incidents for repeated unreachable hosts or degraded health. |
| Backup target polling | `BACKUP_TARGET_POLL_INTERVAL_MINUTES`, default `30` | Polls enabled Synology/PBS targets for capacity. Opens incidents for poll errors or high usage. |
| IMAP polling | `IMAP_POLL_INTERVAL_MINUTES`, default `60` | Reads new email UIDs, stores messages, applies job rules, creates events, links expected runs, and syncs backup incidents for matched failure/warning/OK emails. |
| Expected-run producer | fixed `15` minutes | Creates pending expected runs for enabled jobs. |
| Expected-run deadline evaluator | fixed `1` minute | Marks overdue pending runs as `MISSING` and opens deduplicated critical incidents. |
| Notification sender | fixed `5` minutes | Sends SMTP notifications for open incidents that have not been notified. |
| Retention cleanup | fixed `24` hours | Deletes old operational records according to `RETENTION_DAYS`. |
| Daily report | fixed `1` minute due check | Sends the daily report when local time matches `DAILY_REPORT_TIME`. |

Worker executions skip overlapping runs. Each worker has an in-process guard and a PostgreSQL advisory lock, so duplicate scheduler instances skip work already running elsewhere.

## Backup Job Configuration

Jobs live under **Backup Jobs**.

| Field | Description |
| --- | --- |
| Name | Human-readable job name. |
| System type | One of `VEEAM`, `PBS`, or `SYNOLOGY`. Used for filtering and UI labels. |
| Customer | Optional customer association. |
| Schedule type | `daily` or `weekly`. |
| Schedule time | Local wall-clock time in `HH:MM`, interpreted in `APP_TIMEZONE`. |
| Run days | Required for weekly jobs. Select one or more weekdays. |
| Window hours | Deadline window after scheduled time. If no matching event arrives before the deadline, the expected run becomes missing. |
| Long-running job | Enables a separate long-running deadline window. |
| Long window hours | Deadline window for long-running jobs. |
| Enabled | Disabled jobs do not produce expected runs. |

Expected runs are deduplicated by `(jobId, scheduledFor)`.

## Job Rules And Email Matching

Job rules connect incoming emails to jobs.

| Field | Description |
| --- | --- |
| Job | The backup job this rule maps to. |
| Sender match | Case-insensitive substring that must appear in the email sender. |
| Subject match | Case-insensitive substring that must appear in the subject. |
| Body match | Case-insensitive substring that must appear in the email snippet/body excerpt. |
| Priority | Higher priority rules are evaluated first. |

At least one match field should be set. If multiple fields are set, all set fields must match.

When a rule matches:

- The email is marked as ingested.
- An event is created with status `OK`, `WARN`, `FAIL`, or `UNKNOWN`.
- A pending expected run for that job is linked if the email arrived within its scheduled window.
- `FAIL` and `WARN` events open or update a `BACKUP` incident for the expected run or email. `OK` events resolve the matching backup-status incident.

Status detection is keyword-based:

- Failure keywords include `failed`, `failure`, `error`, `aborted`, `cancelled`, `critical`, `task error`.
- Warning keywords include `warn`, `warning`, `warnings`, `skipped`, `retry`, `degraded`.
- Success keywords include `success`, `successful`, `completed`, `ok`, `finished`.

## Email Inbox

The Email Inbox has two views:

- **Unmatched**: Stored emails that did not match a rule.
- **Matched**: Stored emails linked to jobs.

For unmatched messages, operators can:

- Create a new job from the email.
- Link the email to an existing job.
- Optionally create a sender-based matching rule.

When an email is relinked to a different job or expected run, the previous expected run link is reset and the old backup-status incident is resolved so missed-run evaluation can happen normally.

## Proxmox Host Configuration

Proxmox hosts are monitored over SSH.

| Field | Description |
| --- | --- |
| Display name | Human-readable host name. |
| Host / IP | SSH hostname or IP. |
| Port | SSH port, default `22`. |
| Username | SSH user. |
| Password | SSH password, encrypted before storage. |
| SSH host key fingerprint | Expected SSH host key fingerprint. Recommended for production. |
| Allow unknown host key | Per-host bypass for host key verification. Use only while enrolling. |
| Customer | Optional customer association. |
| Enabled | Disabled hosts are not polled. |

The collector probes:

- Hostname
- ZFS pools
- mdadm arrays
- Hardware RAID hints from `lspci`, `storcli`, or `megacli`
- Disk inventory from `lsblk`
- SMART health from `smartctl`

The remote user needs enough permission to run the relevant commands. If tools are missing or permission is limited, the payload may show partial data.

API responses for Proxmox hosts always redact stored passwords. Single-host responses include the customer name through a direct joined lookup rather than fetching the full host list.

## Backup Target Configuration

Backup targets monitor storage capacity over HTTPS.

| Field | Description |
| --- | --- |
| Display name | Human-readable target name. |
| Server type | `PBS` or `SYNOLOGY`. |
| Host / IP | Target hostname or IP. |
| Port | PBS defaults to `8007`; Synology commonly uses `5001`. |
| Username | Target API username. |
| Password / API token | Target password or token, encrypted before storage. |
| TLS certificate fingerprint | Expected TLS certificate fingerprint. Recommended for self-signed targets. |
| Allow self-signed TLS | Per-target TLS verification bypass. Prefer a fingerprint in production. |
| Customer | Optional customer association. |
| Enabled | Disabled targets are not polled. |

Synology polling uses DSM APIs to authenticate, read volume information, and optionally count shares.

PBS polling authenticates to `/api2/json/access/ticket`, lists datastores, reads datastore status, and counts snapshots when permitted.

API responses for backup targets always redact stored passwords. Single-target responses and manual poll responses include the customer name through a direct joined lookup rather than fetching the full target list.

## Incident Configuration And Notification Routing

Incidents are created from:

- Missed expected backup runs
- Matched backup notification emails with `FAIL` or `WARN` status
- Proxmox unreachable/degraded health
- Backup target poll failures or high capacity usage
- Seed/demo data in development

Matched backup notification emails with `OK` status resolve the matching backup-status incident. Deleting a job, Proxmox host, or backup target resolves incidents tied to that monitored source so stale open incidents are not left behind.

Incident states:

| State | Meaning |
| --- | --- |
| `OPEN` | Needs attention. Eligible for notification if not already sent. |
| `ACKED` | Acknowledged by an operator. |
| `RESOLVED` | Resolved. |

Severity values:

| Severity | Meaning |
| --- | --- |
| `INFO` | Informational. |
| `WARN` | Warning condition. |
| `CRIT` | Critical condition. |

Notification recipients are configured in Settings.

| Recipient field | Description |
| --- | --- |
| Name | Display name. |
| Email | Delivery address. |
| Type | `TECH` or `CLIENT`; currently informational. |
| Customer | Optional customer scope. Global recipients have no customer. |
| Enabled | Disabled recipients are ignored. |

Notification routes are available through API endpoints and the database schema. If no matching route exists, notifications go to enabled global recipients and enabled recipients for the incident customer.

Notification route fields:

| Field | Description |
| --- | --- |
| `scopeType` | `GLOBAL`, `CUSTOMER`, or `JOB`. |
| `scopeId` | Customer ID for customer routes, job ID for job routes, or null for global. |
| `eventType` | `FAIL`, `MISSING`, `WARN`, `DAILY_REPORT`, or `MONITOR_DOWN`. Current workers emit `FAIL`, `MISSING`, `WARN`, and `MONITOR_DOWN`. |
| `severityMin` | Minimum severity: `INFO`, `WARN`, or `CRIT`. |
| `recipientsJson` | Recipient IDs/emails. Accepts arrays or objects containing `id`, `email`, `recipientIds`, or `emails`. |

## Data Retention

The retention worker uses `RETENTION_DAYS`, defaulting to `90` if neither the database setting nor environment variable is set. It removes old events, emails, completed expected runs, Proxmox checks, and non-open incidents. Open incidents are preserved regardless of age.

The Settings Operations tab also includes a manual retention run button.

## Applying Schema Changes

For development or small deployments, use:

```powershell
npm.cmd run db:push
```

This applies the Drizzle schema in `shared/schema.ts` directly to the configured database.

For production, prefer tracked migrations:

```powershell
npm.cmd run db:generate
npm.cmd run db:migrate
```

Production recommendations:

- Back up the database first.
- Run schema changes during a maintenance window.
- Set `DISABLE_SCHEDULER=1` if you want to prevent background workers during maintenance.
- Start the app after schema changes succeed.

## Monitoring The App

Minimum health checks:

- HTTP GET `/healthz` should return `200` with `{ "ok": true }` when the process is alive.
- HTTP GET `/readyz` should return `200` when the database is reachable and enabled scheduler workers are not stale or in error. In production the body is only `{ "ok": true }` or `{ "ok": false }`; outside production it includes database latency plus stale/error worker detail.
- HTTP GET `/api/auth/me` should return `401` when unauthenticated. That still proves the app and database-backed session middleware are responding.
- Watch process logs for scheduler failures.
- Watch PostgreSQL connection counts.
- Confirm recent Proxmox checks and backup target polls update on their pages.
- Confirm Settings IMAP/SMTP test buttons succeed after mail configuration.

The app logs API route method, path, status, and duration for `/api` requests.

### Regression checks

Run before deployment or after significant changes:

```powershell
npm.cmd run verify
```

This covers TypeScript, backend behavior, health response hardening, auth-cache behavior, and frontend workflow payload normalization.

Database-backed integration checks are opt-in because they create and delete rows. To run them, point `DATABASE_URL` at a disposable database and set `RUN_DB_INTEGRATION_TESTS=1` before `npm.cmd run verify`.

## Troubleshooting

### App exits with `DATABASE_URL must be set`

Set `DATABASE_URL` in `.env` or the process environment.

### Production boot fails with missing secrets

Set:

- `SESSION_SECRET`
- `SECRET_ENCRYPTION_KEY`
- `ADMIN_PASSWORD` or `ADMIN_PASSWORD_HASH`

### Login works over HTTP but not behind HTTPS proxy

Check:

- `TRUST_PROXY=1`
- `COOKIE_SECURE=1`
- Reverse proxy sends `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto`, and `X-Forwarded-For`
- Browser is using HTTPS

### Mutating API requests return `403`

The origin protection rejected the request. Make sure the browser URL host matches the forwarded host seen by Express. Behind a proxy, set `TRUST_PROXY=1` and forward `X-Forwarded-Host`.

### IMAP test fails

Check:

- Host, port, username, and password
- App password requirements
- Firewall from app server to IMAP server
- `IMAP_TLS=1` for port `993`
- Folder name, usually `INBOX`

### SMTP test fails

Check:

- Host and port
- `SMTP_STARTTLS=1` for port `587`
- Port `465` for implicit TLS
- Username/password
- Firewall from app server to SMTP server
- Whether the SMTP provider allows this sender address

### Proxmox check shows unknown or partial data

Check:

- SSH reachability
- Username/password
- SSH host key fingerprint
- Availability of `zpool`, `smartctl`, `lsblk`, `lspci`, `storcli`, or `megacli`
- Permissions for hardware/SMART commands

### Backup target polling fails with TLS errors

Preferred fix:

- Add the target TLS fingerprint.

Temporary development fix:

- Enable per-target `allowInsecureTls`, or set `ALLOW_INSECURE_TARGET_TLS=1`.

### Target save or poll fails with `EGRESS_BLOCKED`

The host resolved to an address class ProtectiveShell refuses to monitor, such as loopback, link-local, multicast, unspecified, or a metadata service address. Use a routable target address. If your deployment intentionally monitors a narrow internal range, set `MONITORED_TARGET_ALLOW_CIDRS` to that CIDR list and restart.

### Build fails with `spawn EPERM`

This is a host policy issue blocking Vite/esbuild or tsx subprocesses. It can also prevent `npm.cmd run dev` because development mode compiles TypeScript through tsx. Use Node 20/22 on a machine or CI runner where Node child processes are allowed, or build on Linux and deploy `dist/`.

## Upgrade Checklist

1. Back up PostgreSQL.
2. Pull the new code.
3. Run `npm ci`.
4. Run `npm.cmd run verify`.
5. Run `npm.cmd run db:push`.
6. Run `npm.cmd run build`.
7. Restart the production process.
8. Sign in and verify dashboard, Settings IMAP/SMTP tests, and recent worker activity.

## Production Checklist

- `NODE_ENV=production`
- PostgreSQL backups configured
- `SESSION_SECRET` set to a long random value
- `SECRET_ENCRYPTION_KEY` set to a stable random value and stored safely
- Strong admin password or hash configured
- App behind HTTPS
- `TRUST_PROXY=1` only when behind a trusted proxy
- `COOKIE_SECURE=1` when served over HTTPS
- Insecure SSH/TLS global bypasses disabled
- `MONITORED_TARGET_ALLOW_CIDRS` set if monitoring should be constrained to specific internal ranges
- Per-host SSH fingerprints configured
- Per-target TLS fingerprints configured where possible
- SMTP test succeeds
- IMAP test succeeds
- Recipients configured
- Scheduler enabled only on instances intended to run workers; duplicate workers use PostgreSQL advisory locks but web-only instances should still use `DISABLE_SCHEDULER=1`
