#!/bin/sh
set -e

if [ "$(id -u)" = "0" ]; then
  # Running as root: use PUID/PGID env vars to set up user/group, fix ownership, then drop privileges
  PUID=${PUID:-1000}
  PGID=${PGID:-1000}

  if ! getent group "$PGID" > /dev/null 2>&1; then
    addgroup -g "$PGID" appgroup
  fi

  if ! getent passwd "$PUID" > /dev/null 2>&1; then
    adduser -D -u "$PUID" -G "$(getent group "$PGID" | cut -d: -f1)" appuser
  fi

  chown -R "$PUID:$PGID" /data
  exec su-exec "$PUID:$PGID" "$@"
else
  # Already running as a non-root user (e.g. via `user:` in docker-compose) — use whoever we are
  exec "$@"
fi
