# Remarcal

A self-hosted, private tool to sync CalDAV calendars to reMarkable Paper Pro as PDF planners.

## Features

- **Multi-document Library**: Manage multiple planner configurations.
- **Sync when Connected**: Every 5 minutes, the app performs a lightweight device connectivity check and syncs linked documents when a device is reachable.
- **Secure**: 
  - CalDAV credentials encrypted at rest.
  - Device credentials encrypted at rest.
- **Dockerized**: Easy deployment with Docker Compose.
- **Persistence**: All data stored in a single volume.

## Getting Started

### Prerequisites

- Docker & Docker Compose
- SSH access to your reMarkable device (username/password).
- A CalDAV account (e.g., Google Calendar, Fastmail, Nextcloud).

### Installation

1. **Clone the repository** (or download files).

2. **Configure SSH Access**:
   Set `REMARKABLE_PASSWORD` in your `.env` file (used as a default/fallback when no device is configured in-app).

3. **Configure Environment**:
   Create a `.env` file based on `.env.example`.

   ```bash
   APP_MASTER_KEY=your_very_long_random_hex_string_at_least_32_bytes
   REMARKABLE_HOST=10.11.99.1
   REMARKABLE_USER=root
   REMARKABLE_PASSWORD=your_password
   ```

   **Important**: `APP_MASTER_KEY` is used to encrypt your CalDAV passwords. Keep it safe.

4. **Run with Docker Compose**:

   ```bash
   docker compose up -d
   ```

   The app will be available at `http://localhost:3000`.

### Usage

1. **Settings**: Go to the Settings tab and add a CalDAV account.
2. **Devices**: Add and verify your reMarkable SSH connection.
3. **Library**: Go to the Library tab and add a Document.
   - **Remote Path**: The full path on the reMarkable where the PDF should be uploaded. 
     - Example: `/home/root/.local/share/remarkable/xochitl/calendar.pdf` (Note: This replaces the file directly. Ensure you have a backup or use a unique name).
4. **Devices**: Enable **Sync when connected** per device if you want automatic background sync.
5. **Sync**: Manually sync anytime, or let automatic sync run whenever an enabled device is reachable.

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

- **APP_MASTER_KEY**: Used for AES-256-GCM encryption of sensitive fields in the DB.
- **Credentials**: CalDAV and device passwords are encrypted before storing in SQLite.
- **Bind Address**: By default, the app binds to `127.0.0.1` to prevent accidental exposure. To expose to LAN, change the port mapping in `docker-compose.yml` to `0.0.0.0:3000:3000`.

## Troubleshooting

- **Sync Failed**: Check logs (`docker compose logs -f app`).
- **SSH Connection**: Ensure the container can reach the reMarkable IP. If using USB IP (`10.11.99.1`), the container needs access to the host network or the device needs to be on WiFi.
- **CalDAV Error**: Verify URL and credentials. Some providers require App Passwords.

## Development

To run locally without Docker:

1. Install dependencies: `npm install`
2. Set env vars (see `.env.example`).
3. Run: `npm run dev` (Frontend) and `tsx server.ts` (Backend).
   *Note: The provided setup is optimized for Docker.*
