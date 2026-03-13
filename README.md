# Remarcal

A self-hosted, private tool to sync calendar data (CalDAV + ICS subscriptions) to reMarkable Paper Pro as PDF planners.

This project was built entirely with AI assistance.

## Features

- **Multi-document Library**: Manage multiple planner configurations with customizable titles, years, timezones, and remote paths on the device.
- **Sync when Connected**: Every 2 minutes, the app performs a lightweight device connectivity check and syncs linked documents when a device is reachable.
- **Calendars Tab**:
  - Add **CalDAV** sources (Google Calendar, Fastmail, Nextcloud, etc.) with encrypted credential storage.
  - Add **ICS subscriptions** (URL-based calendar feeds) with configurable refresh cadence (15-1440 minutes).
  - Discover and select specific calendars from CalDAV accounts.
  - Merge events from multiple CalDAV accounts and ICS subscriptions into a single PDF, including recurring events and participation status (accepted, declined, tentative).
- **Device Management**:
  - Register reMarkable devices via SSH with host key pinning (TOFU).
  - Support for password or SSH key-based authentication, with optional password fallback.
  - Automatic connectivity checks and sync triggering.
- **Automatic Backups**: Scheduled device backups with configurable retention policies (default: 30 days, 20 backups per device, 20GB total limit). Includes manifest generation with file hashing for integrity.
- **Activity Logging**: Structured JSON logging of operations, syncs, backups, and errors for monitoring and troubleshooting.
- **Secure**: 
  - Session-based UI/API authentication (single-user admin password) with rate limiting.
  - SSH host key pinning (TOFU on first enrollment) and optional key-based device auth enrollment.
  - AES-256-GCM authenticated encryption for all sensitive data (CalDAV credentials, ICS URLs, device passwords/keys) with per-record keys.
  - TLS validation enforcement (app refuses startup if TLS is disabled).
  - Security headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy).
- **Dockerized**: Easy deployment with Docker Compose.
- **Persistence**: All data stored in a single volume, including SQLite database, generated PDFs, logs, SSH keys, and backups.

## Getting Started

### Prerequisites

- Docker & Docker Compose
- SSH access to your reMarkable device (username/password).
- A CalDAV account (e.g., Google Calendar, Fastmail, Nextcloud).

### Installation

1. **Clone the repository** (or download files).

2. **Configure Environment**:
   Create a `.env` file based on `.env.example`.

   ```bash
   APP_MASTER_KEY=your_long_random_master_key
   APP_ADMIN_PASSWORD=your_admin_ui_password
   APP_ALLOWED_ORIGIN=http://localhost:3000
   NODE_ENV=production
   PORT=3000
   DATA_DIR=/data
   APP_SECURE_COOKIES=false
   CALENDAR_TRACE=0
   CAL_TRACE_INGEST=0
   CAL_TRACE_SYNC=0
   CAL_TRACE_PDF=0
   CAL_TRACE_TZ_FALLBACK=0
   CAL_TRACE_LIMIT=80
   CAL_TRACE_DAY=
   CALDAV_HOSTNAME=nas.local
   CALDAV_HOST_IP=192.168.1.10
   ```

   **Important**:
   - `APP_MASTER_KEY` is required and must be at least 32 characters.
   - `APP_ADMIN_PASSWORD` is required; app refuses startup without it.
   - Ensure these values are in `.env` (not just `.env.example`).
   - Keep `APP_SECURE_COOKIES=false` when accessing over HTTP on LAN. Set `true` only behind HTTPS.
   - If your CalDAV host requires static DNS override inside container, set `CALDAV_HOSTNAME` + `CALDAV_HOST_IP`.
   - Compose now supports overriding runtime and host mapping via env vars (works well with Portainer stack env settings).

4. **Run with Docker Compose**:

   ```bash
   docker compose up -d
   ```

   The app will be available at `http://localhost:3000`.

### Usage

1. **Calendars**:
   - Add one or more **CalDAV** accounts.
   - Optionally add **Subscription** feeds using `.ics`/iCal URLs and set update frequency.
   - Note: subscription URLs often contain secret tokens and are handled as credentials.
2. **Login** with your admin password.
3. **Devices**: Add and verify your reMarkable SSH connection.
   - Optionally run key enrollment to switch device auth mode to SSH key.
4. **Library**: Go to the Library tab and add a Document.
   - **Remote Path**: The full path on the reMarkable where the PDF should be uploaded. 
     - Example: `/home/root/.local/share/remarkable/xochitl/calendar.pdf` (Note: This replaces the file directly. Ensure you have a backup or use a unique name).
   - Select any combination of CalDAV accounts and Subscriptions for this document.
5. **Devices**: Enable **Sync when connected** per device if you want automatic background sync.
6. **Sync**: Manually sync anytime, or let automatic sync run whenever an enabled device is reachable.

## Persistence & Backup

All application state is stored in the `remarcal_data` Docker volume, mounted at `/data` inside the container.

- **Database**: `/data/app.db` (SQLite with WAL mode)
- **Generated PDFs**: `/data/docs/`
- **Logs**: `/data/logs/` (structured JSON activity logs)
- **SSH Keys**: `/data/ssh/` (device SSH private keys with restrictive permissions)
- **Device Backups**: `/data/backups/` (automatic snapshots of reMarkable xochitl directory)

**Automatic Device Backups**:
The app can perform scheduled backups of your reMarkable device. Configure backup frequency per device (default 24 hours). Backups include a manifest with document inventory and SHA256 file hashes. Retention policies automatically clean up old backups (default: keep 30 days, 20 backups per device, total 20GB limit).

**To Backup Application Data**:
Create a backup of the Docker volume.
```bash
docker run --rm -v remarcal_data:/data -v $(pwd):/backup ubuntu tar cvf /backup/backup.tar /data
```

**To Restore Application Data**:
```bash
docker run --rm -v remarcal_data:/data -v $(pwd):/backup ubuntu tar xvf /backup/backup.tar -C /
```

## Security

- **Master key source**: `APP_MASTER_KEY` environment variable.
- **Encryption**: sensitive DB fields use authenticated encryption with backward-compatible migration support.
- **Credentials**: CalDAV credentials, subscription URLs, device passwords, and SSH private keys are encrypted before storing in SQLite.
- **Auth**: all API routes except health/auth require session authentication.
- **TLS safety**: app refuses startup if `NODE_TLS_REJECT_UNAUTHORIZED=0`.

## Troubleshooting

- **Sync Failed**: Check logs (`docker compose logs -f app`). Also review activity logs in `/data/logs/info.log` for detailed sync operations.
- **SSH Connection**: Ensure the container can reach the reMarkable IP. If using USB IP (`10.11.99.1`), the container needs access to the host network or the device needs to be on WiFi.
- **CalDAV Error**: Verify URL and credentials. Some providers require App Passwords.
- **Health Check**: Visit `http://localhost:3000/api/health` to verify the app is running (no authentication required).

## Development

To run locally without Docker:

1. Install dependencies: `npm install`
2. Set env vars (see `.env.example`).
3. Run: `npm run dev` (Frontend) and `npm run dev:server` (Backend).
   *Note: The provided setup is optimized for Docker.*

### Calendar trace debugging (optional)

If subscription/PDF times look wrong, enable verbose tracing in the backend:

1. Set env vars (example):
   - `CALENDAR_TRACE=1`
   - (optional per-stage) `CAL_TRACE_INGEST=1`, `CAL_TRACE_SYNC=1`, `CAL_TRACE_PDF=1`, `CAL_TRACE_TZ_FALLBACK=1`
   - (optional shaping) `CAL_TRACE_LIMIT=120`, `CAL_TRACE_DAY=2026-02-16`
   - `APP_ADMIN_PASSWORD=...`
   - `APP_MASTER_KEY=...`
2. Start backend with `npm run dev:server`.
3. Trigger document sync/PDF generation and inspect `[calendar-trace] ...` lines in backend logs.

Notes:
- `npm run dev` starts only frontend Vite, so trace logs will not appear there.
- Truthy values for `CALENDAR_TRACE`: `1`, `true`, `yes`, `on`.
- If `CALENDAR_TRACE` is enabled, all trace families default to on unless explicitly set.
- You can enable only one layer by leaving `CALENDAR_TRACE=0` and setting a specific `CAL_TRACE_*` flag to `1`.
