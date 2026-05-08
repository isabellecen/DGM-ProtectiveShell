# ProtectiveShell

ProtectiveShell is an internal monitoring dashboard for backup outcomes, backup storage capacity, Proxmox host health, and operational incidents. It combines a React dashboard with an Express API, PostgreSQL storage, scheduled polling, and encrypted secret handling.

The application is built to help technical teams spot missed backups, unmatched backup notification emails, storage pressure, degraded Proxmox storage, SMART warnings, and unresolved incidents from one place.

## Features

- Dashboard with backup, host, incident, and recent activity summaries
- Admin login with PostgreSQL-backed sessions
- Customer management
- Backup job tracking for Veeam, Proxmox Backup Server, and Synology jobs
- Expected-run scheduling with missed-backup incident creation
- Email inbox workflow for unmatched and matched backup notification emails
- Backup email failure/warning incident creation and OK-state incident resolution
- Job matching rules for linking backup emails to backup jobs
- Backup target capacity monitoring for Synology DSM and Proxmox Backup Server
- Proxmox host health checks over SSH
- ZFS, hardware RAID, mdadm, and SMART health summaries
- Proxmox check history and per-host detail views
- Incident state management
- Notification recipient and route configuration
- Confirmation dialogs for destructive operator actions
- IMAP polling for backup notification ingestion
- SMTP delivery for incident notifications
- Daily operational summary emails
- Scheduler status, audit history, and retention cleanup controls
- Health and readiness endpoints for process/database/scheduler monitoring
- Dark/light theme support
- Demo seed data in development

## Tech Stack

- Frontend: React, TypeScript, Vite, Tailwind CSS, Radix/shadcn-style UI components, Wouter, TanStack Query
- Backend: Node.js, Express, Passport local auth, express-session
- Database: PostgreSQL, Drizzle ORM, Drizzle Kit
- Monitoring integrations: SSH via `ssh2`, Synology DSM API, Proxmox Backup Server API
- Build: Vite for the client, esbuild for the server

## Requirements

- Node.js 20 or newer
- npm
- PostgreSQL database
- Network access from the server to monitored Synology, PBS, and Proxmox targets

## Getting Started

Install dependencies:

```bash
npm install
```

Create your environment file from the example:

```bash
cp .env.example .env
```

On PowerShell:

```powershell
Copy-Item .env.example .env
```

Edit `.env` and set at least:

```env
DATABASE_URL=postgres://user:password@localhost:5432/protectiveshell
SESSION_SECRET=replace-with-a-long-random-string
SECRET_ENCRYPTION_KEY=replace-with-a-stable-32-byte-key
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-before-production
```

Push the Drizzle schema into the database:

```bash
npm run db:push
```

Start the development server:

```bash
npm run dev
```

The app serves both the API and the frontend on `http://localhost:5000` by default.

Development mode seeds sample data automatically when the database has no customers. In production, seed data only runs when `SEED_ON_BOOT=1`.

## Windows Note

The npm scripts use `script/run-with-env.cjs` so `npm run dev` and `npm start` work across Linux/macOS shells and native Windows PowerShell.

If PowerShell blocks the `npm` shim with a script execution policy error, call the Windows command shim directly:

```powershell
npm.cmd run dev
```

The same applies to verification and builds:

```powershell
npm.cmd run verify
npm.cmd run build
```

`npm run build` and `npm run dev` use tools such as Vite, tsx, and esbuild that start helper processes. If a locked-down Windows host blocks Node child processes with `spawn EPERM`, run verification locally and build on CI/Linux or adjust the host policy so Node can start those helpers.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Starts the Express API and Vite-powered frontend in development |
| `npm run build` | Builds the frontend into `dist/public` and bundles the server to `dist/index.cjs` |
| `npm start` | Starts the production server from `dist/index.cjs` |
| `npm run check` | Runs TypeScript type checking |
| `npm test` | Runs the focused server and client regression tests |
| `npm run verify` | Runs type checking and tests |
| `npm run db:push` | Applies the Drizzle schema to the configured PostgreSQL database |
| `npm run db:generate` | Generates tracked Drizzle migration files |
| `npm run db:migrate` | Applies tracked Drizzle migrations |
| `npm run admin:hash-password -- "password"` | Generates an `ADMIN_PASSWORD_HASH` value |

## Configuration

Environment variables:

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | Runtime mode, usually `development` or `production` |
| `PORT` | HTTP port, defaults to `5000` |
| `APP_TIMEZONE` | Default application timezone |
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Secret used to sign session cookies |
| `ADMIN_USERNAME` | Admin login username, defaults to `admin` |
| `ADMIN_PASSWORD` | Plain admin password |
| `ADMIN_PASSWORD_HASH` | Optional `scrypt:` admin password hash. Takes precedence over `ADMIN_PASSWORD` |
| `TRUST_PROXY` | Set to `1` when deployed behind a trusted proxy |
| `COOKIE_SECURE` | Set to `1` to force secure cookies |
| `SECRET_ENCRYPTION_KEY` | Stable key used to encrypt stored target credentials and secret settings |
| `SEED_ON_BOOT` | Set to `1` to seed demo data on boot when the database is empty |
| `DISABLE_SCHEDULER` | Set to `1` to disable background polling and expected-run evaluation |
| `PROXMOX_POLL_INTERVAL_MINUTES` | Proxmox health polling interval, default `5` |
| `BACKUP_TARGET_POLL_INTERVAL_MINUTES` | Backup target capacity polling interval, default `30` |
| `IMAP_POLL_INTERVAL_MINUTES` | IMAP polling interval, default `60` |
| `RETENTION_DAYS` | Retention window for old emails, checks, expected runs, and resolved incidents, default `90` |
| `LOGIN_RATE_LIMIT_MAX` | Login attempts allowed per 15-minute window, default `8` |
| `ALLOW_INSECURE_TARGET_TLS` | Development escape hatch for self-signed target TLS |
| `ALLOW_INSECURE_SSH_HOST_KEYS` | Development escape hatch for SSH host key verification |
| `ALLOW_PRODUCTION_INSECURE_TARGETS` | Explicit production override for insecure target TLS/SSH bypasses |

Application settings are also editable from the Settings page. The current UI includes IMAP, SMTP, recipients, notification routes, operations, audit history, and general settings such as `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASS`, `IMAP_POLL_INTERVAL`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `APP_TIMEZONE`, `RETENTION_DAYS`, `SSH_TIMEOUT`, `CONSECUTIVE_FAILURE_THRESHOLD`, and `DAILY_REPORT_TIME`. Secret fields are returned blank; saving a blank field preserves the current value, and the clear action removes the stored secret.

## Security Notes

- All `/api` routes require an authenticated admin session, except login/logout/session-check routes needed for auth.
- Sessions are stored in PostgreSQL in the `user_sessions` table.
- Proxmox host passwords, backup target passwords, and secret-like settings are encrypted before storage.
- Mutating API requests reject cross-site origins, login attempts are rate-limited, and common browser security headers are set by the server.
- `/readyz` returns detailed database and scheduler diagnostics outside production, but production only returns the top-level readiness result.
- Use a stable `SECRET_ENCRYPTION_KEY`; changing it can prevent previously encrypted secrets from decrypting.
- In production, set `SESSION_SECRET` and either `ADMIN_PASSWORD` or `ADMIN_PASSWORD_HASH`.
- Prefer SSH host key fingerprints and TLS fingerprints for monitored targets. Pinned TLS fingerprints are validated before target credentials are sent. The insecure bypass flags are intended only for isolated development or legacy environments; production requires `ALLOW_PRODUCTION_INSECURE_TARGETS=1` before those bypasses are accepted.

## Project Structure

```text
client/
  index.html
  src/
    App.tsx
    components/
      confirm-action.tsx  Reusable destructive-action confirmation dialog
    hooks/
    lib/
      workflow-payloads.ts  Shared client request-payload builders
    pages/

server/
  auth.ts              Admin auth and session setup
  backupPoller.ts      Synology DSM and PBS capacity polling
  crypto.ts            Secret encryption helpers
  db.ts                PostgreSQL and Drizzle connection
  index.ts             Express server entry point
  monitoring.ts        Persistence wrapper for health checks and polls
  proxmoxCollector.ts  SSH-based Proxmox storage and SMART collection
  routes.ts            API routes
  scheduler.ts         Background polling and expected-run checks
  seed.ts              Development demo data
  storage.ts           Database storage layer

shared/
  schema.ts            Drizzle tables and shared types
  monitoringPayloads.ts Shared Zod schemas for monitoring JSON payloads

script/
  build.mjs            Production build script
```

## API Overview

The server exposes authenticated REST endpoints under `/api` for:

- Auth: `/api/auth/login`, `/api/auth/logout`, `/api/auth/me`
- Dashboard stats
- Customers
- Backup jobs and job rules
- Expected runs and backup events
- Emails, unmatched emails, matched emails, and email-to-job linking
- Proxmox hosts, checks, and manual check runs
- Backup targets and manual capacity polls
- Incidents
- Recipients and notification routes
- Scheduler status, audit logs, and maintenance actions
- App settings

Unauthenticated health endpoints are also available:

- `/healthz` returns a lightweight liveness result.
- `/readyz` checks database readiness and scheduler state. Non-production responses include diagnostic detail; production responses only expose the top-level readiness boolean.

See `server/routes.ts` for the exact route list and request schemas.

For production deployment, operations, and a complete configuration reference, see [OPERATIONS.md](OPERATIONS.md).

## Production Build

Build the app:

```bash
npm run build
```

Start the bundled server:

```bash
npm start
```

In production, the Express server serves static frontend files from `dist/public` and the API from the same port.

Production builds intentionally omit development-only Vite helper plugins such as the runtime error overlay.

## Test Coverage

`npm run verify` runs TypeScript plus focused server and client regression tests. Current client coverage includes auth-cache behavior and workflow payload builders for login, jobs, email linking, backup targets, Proxmox hosts, settings, recipients, and notification routes.

## Monitoring Behavior

When the scheduler is enabled:

- Proxmox hosts are checked every `PROXMOX_POLL_INTERVAL_MINUTES`.
- Backup targets are polled every `BACKUP_TARGET_POLL_INTERVAL_MINUTES`.
- IMAP is polled every `IMAP_POLL_INTERVAL_MINUTES` when IMAP settings are configured.
- Expected backup runs are produced every 15 minutes.
- Pending expected runs are checked every minute. Missed deadlines become `MISSING` and create open critical backup incidents.
- Matched backup emails with `FAIL` or `WARN` status open or update backup incidents. Matched `OK` emails resolve the matching backup-status incident.
- Open incidents with unsent notifications are delivered through SMTP every 5 minutes when SMTP settings and recipients are configured.

Manual "run check" and "poll now" actions are available in the UI for Proxmox hosts and backup targets.
The Settings page also includes IMAP and SMTP connection tests.
