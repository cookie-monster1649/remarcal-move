import db from '../db.js';
import { CalDavService } from './caldavService.js';
import { decrypt } from './encryptionService.js';

const POLL_INTERVAL_MS = 15 * 60 * 1000;

// ── Types ──────────────────────────────────────────────────────────────────────

type FetchWindow = {
  rangeStart?: Date;
  rangeEnd?: Date;
};

// ── Service ────────────────────────────────────────────────────────────────────

export class CaldavPollerService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly caldavService = new CalDavService();

  // ── Lifecycle ──

  start() {
    if (this.timer) return;
    void this.runCycle();
    this.timer = setInterval(() => void this.runCycle(), POLL_INTERVAL_MS);
    console.log('CalDAV poller started (poll every 15 minutes)');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async runCycle() {
    if (this.running) return;
    this.running = true;
    try {
      await this.fetchAllAccounts();
    } finally {
      this.running = false;
    }
  }

  // ── Window helpers ──

  // Default window: year-1 to year+2 — wide enough to cover any document year.
  // { start: 2025-01-01, end: 2028-12-31 } when called in 2026
  private defaultWindow(): { start: Date; end: Date } {
    const now = new Date();
    return {
      start: new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1, 0, 0, 0, 0)),
      end: new Date(Date.UTC(now.getUTCFullYear() + 2, 11, 31, 23, 59, 59, 999)),
    };
  }

  // ── Public fetch entry point ──

  // Called by generateDocumentPDF with an explicit range, or by the poller with
  // no arguments (uses the default window).
  async fetchAccount(accountId: string, window: FetchWindow = {}): Promise<void> {
    const account = db
      .prepare('SELECT * FROM caldav_accounts WHERE id = ?')
      .get(accountId) as any;
    if (!account) return;

    const password = decrypt(account.encrypted_password);
    const win = this.defaultWindow();
    const rangeStart = window.rangeStart ?? win.start;
    const rangeEnd = window.rangeEnd ?? win.end;

    // startDate/endDate in the YYYY-MM-DD format that caldavService expects.
    const startDate = rangeStart.toISOString().slice(0, 10);
    const endDate = rangeEnd.toISOString().slice(0, 10);

    let selectedCalendars: Array<{ url: string }> = [];
    try {
      selectedCalendars = JSON.parse(account.selected_calendars || '[]');
    } catch {
      // ignore parse errors — fall back to account root URL
    }
    const calendarUrls = selectedCalendars.length > 0
      ? selectedCalendars.map((c: any) => c.url)
      : [account.url];

    for (const calendarUrl of calendarUrls) {
      try {
        await this.fetchCalendar(
          accountId,
          calendarUrl,
          account.username,
          password,
          startDate,
          endDate,
        );
      } catch (err: any) {
        console.warn(
          `CalDAV poll failed for account ${account.name} calendar ${calendarUrl}: ${err?.message || err}`,
        );
      }
    }
  }

  // ── Per-calendar fetch ──

  private async fetchCalendar(
    accountId: string,
    calendarUrl: string,
    username: string,
    password: string,
    startDate: string,
    endDate: string,
  ): Promise<void> {
    const { events } = await this.caldavService.fetchEvents({
      url: calendarUrl,
      username,
      password,
      startDate,
      endDate,
    });

    // Authoritative snapshot: stamp every returned event with seenAt, then
    // delete rows in this calendar's range that were not seen in this fetch.
    // { uid: 'abc123', recurrence_id: '', start_at: '2026-04-15T10:00:00.000Z', ... }
    const seenAt = new Date().toISOString();

    const upsert = db.prepare(`
      INSERT INTO caldav_events (
        account_id, calendar_url, uid, recurrence_id, summary,
        start_at, end_at, location, description, all_day, timezone, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, calendar_url, uid, recurrence_id) DO UPDATE SET
        summary       = excluded.summary,
        start_at      = excluded.start_at,
        end_at        = excluded.end_at,
        location      = excluded.location,
        description   = excluded.description,
        all_day       = excluded.all_day,
        timezone      = excluded.timezone,
        last_seen_at  = excluded.last_seen_at
    `);

    const pruneRange = db.prepare(`
      DELETE FROM caldav_events
      WHERE account_id   = ?
        AND calendar_url = ?
        AND last_seen_at <> ?
        AND end_at       >= ?
        AND start_at     <= ?
    `);

    db.transaction(() => {
      for (const event of events) {
        // UID is required by the iCal spec; fall back to a positional key if absent.
        const uid = event.uid || `${calendarUrl}::${event.start.toISOString()}`;
        const recurrenceId = event.recurrenceId ?? '';

        upsert.run(
          accountId,
          calendarUrl,
          uid,
          recurrenceId,
          event.summary || null,
          event.start.toISOString(),
          event.end.toISOString(),
          event.location || null,
          event.description || null,
          event.allDay ? 1 : 0,
          event.timezone || null,
          seenAt,
        );
      }

      pruneRange.run(
        accountId,
        calendarUrl,
        seenAt,
        `${startDate}T00:00:00.000Z`,
        `${endDate}T23:59:59.999Z`,
      );
    })();
  }

  // ── Background cycle ──

  private async fetchAllAccounts(): Promise<void> {
    const accounts = db
      .prepare('SELECT id FROM caldav_accounts')
      .all() as Array<{ id: string }>;

    for (const account of accounts) {
      try {
        await this.fetchAccount(account.id);
      } catch (err: any) {
        console.warn(`CalDAV poll failed for account ${account.id}: ${err?.message || err}`);
      }
    }
  }
}

export const caldavPollerService = new CaldavPollerService();
