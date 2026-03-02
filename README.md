# Remarcal

A self-hosted, private tool to sync CalDAV calendars to reMarkable Paper Pro as PDF planners.

## Features

- **Multi-document Library**: Manage multiple planner configurations.
- **Scheduled Sync**: Automatically update your planner on the device (e.g., daily).
- **Secure**: 
  - CalDAV credentials encrypted at rest.
  - SSH keys mounted read-only.
  - Basic Authentication.
- **Dockerized**: Easy deployment with Docker Compose.
- **Persistence**: All data stored in a single volume.

## Getting Started

### Prerequisites

- Docker & Docker Compose
- An SSH key pair authorized on your reMarkable device.
- A CalDAV account (e.g., Google Calendar, Fastmail, Nextcloud).

### Installation

1. **Clone the repository** (or download files).

2. **Configure SSH Access**:
   - **Option A: SSH Key (Recommended)**:
     Place your private SSH key in `./ssh_key`.
     Ensure `REMARKABLE_SSH_KEY_PATH` is set to `/app/ssh_key` in `.env`.
   - **Option B: Password**:
     Set `REMARKABLE_PASSWORD` in your `.env` file.
     You can remove the `./ssh_key` volume mount in `docker-compose.yml` if not using keys.

3. **Configure Environment**:
   Create a `.env` file based on `.env.example`.

   ```bash
   APP_MASTER_KEY=your_very_long_random_hex_string_at_least_32_bytes
   REMARKABLE_HOST=10.11.99.1
   REMARKABLE_USER=root
   # If using password:
   REMARKABLE_PASSWORD=your_password
   # If using key:
   REMARKABLE_SSH_KEY_PATH=/app/ssh_key
   ```

   **Important**: `APP_MASTER_KEY` is used to encrypt your CalDAV passwords. Keep it safe.

4. **Run with Docker Compose**:

   ```bash
   docker compose up -d
   ```

   The app will be available at `http://localhost:3000`.

### Usage

1. **Login**: Use the credentials defined in `AUTH_USER` / `AUTH_PASS`.
2. **Settings**: Go to the Settings tab and add a CalDAV account.
3. **Library**: Go to the Library tab and add a Document.
   - **Remote Path**: The full path on the reMarkable where the PDF should be uploaded. 
     - Example: `/home/root/.local/share/remarkable/xochitl/calendar.pdf` (Note: This replaces the file directly. Ensure you have a backup or use a unique name).
   - **Schedule**: Cron expression (e.g., `0 0 * * *` for daily at midnight).
4. **Sync**: You can manually sync or wait for the schedule.

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
- **SSH Key**: Mounted read-only into the container. Never stored in the DB.
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
