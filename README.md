# Remarcal

A self-hosted, private tool to sync calendar data (CalDAV + ICS subscriptions) to reMarkable Paper Pro as PDF planners.

## Features

- **Multi-document Library**: Manage multiple planner configurations.
- **Sync when Connected**: Every 5 minutes, the app performs a lightweight device connectivity check and syncs linked documents when a device is reachable.
- **Calendars Tab**:
  - Add **CalDAV** sources.
  - Add **ICS subscriptions** (URL-based calendar feeds) with configurable refresh cadence.
  - Select both CalDAV and subscription sources per document and merge into a single generated calendar PDF.
- **Secure**: 
  - Session-based UI/API authentication (single-user admin password).
  - SSH host key pinning (TOFU on first enrollment) and optional key-based device auth enrollment.
  - CalDAV credentials encrypted at rest.
  - ICS subscription URLs are treated as credentials and stored encrypted at rest.
  - Device credentials/keys encrypted at rest.
- **Dockerized**: Easy deployment with Docker Compose.
- **Persistence**: All data stored in a single volume.

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

- **Database**: `/data/app.db` (SQLite)
- **Generated PDFs**: `/data/docs/`

**To Backup**:
Create a backup of the Docker volume.
```bash
docker run --rm -v remarcal_data:/data -v $(pwd):/backup ubuntu tar cvf /backup/backup.tar /data
```

**To Restore**:
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

- **Sync Failed**: Check logs (`docker compose logs -f app`).
- **SSH Connection**: Ensure the container can reach the reMarkable IP. If using USB IP (`10.11.99.1`), the container needs access to the host network or the device needs to be on WiFi.
- **CalDAV Error**: Verify URL and credentials. Some providers require App Passwords.

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
