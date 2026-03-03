import axios from 'axios';
import crypto from 'crypto';
import ICAL from 'ical.js';
import db from '../db.js';
import { decrypt } from './encryptionService.js';

type SubscriptionRow = {
  id: string;
  encrypted_url: string;
  update_frequency_minutes: number;
  enabled: number;
  last_etag: string | null;
  last_modified: string | null;
  last_body_hash: string | null;
};

export class SubscriptionService {
  private readonly minFrequencyMinutes = 15;

  private bodyHash(body: string): string {
    return crypto.createHash('sha256').update(body).digest('hex');
  }

  shouldFetch(sub: { update_frequency_minutes?: number; last_fetched_at?: string | null }): boolean {
    if (!sub.last_fetched_at) return true;
    const frequency = Math.max(this.minFrequencyMinutes, Number(sub.update_frequency_minutes || 30));
    const lastFetched = new Date(sub.last_fetched_at).getTime();
    if (!Number.isFinite(lastFetched)) return true;
    return Date.now() - lastFetched >= frequency * 60 * 1000;
  }

  async fetchSubscription(subscriptionId: string): Promise<void> {
    const sub = db
      .prepare('SELECT id, encrypted_url, update_frequency_minutes, enabled, last_etag, last_modified, last_body_hash FROM calendar_subscriptions WHERE id = ?')
      .get(subscriptionId) as SubscriptionRow | undefined;

    if (!sub || !sub.enabled) return;

    const url = decrypt(sub.encrypted_url);
    const headers: Record<string, string> = {
      'User-Agent': 'Remarcal/1.0',
      Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.8',
    };

    if (sub.last_etag) headers['If-None-Match'] = sub.last_etag;
    if (sub.last_modified) headers['If-Modified-Since'] = sub.last_modified;

    const nowIso = new Date().toISOString();

    try {
      const response = await axios.get(url, {
        responseType: 'text',
        timeout: 20000,
        headers,
        validateStatus: (status) => (status >= 200 && status < 300) || status === 304,
      });

      if (response.status === 304) {
        db.prepare('UPDATE calendar_subscriptions SET last_fetched_at = ?, last_success_at = ?, last_error = NULL WHERE id = ?').run(nowIso, nowIso, subscriptionId);
        return;
      }

      const body = typeof response.data === 'string' ? response.data : String(response.data || '');
      const hash = this.bodyHash(body);

      db.prepare(`
        UPDATE calendar_subscriptions
        SET last_fetched_at = ?,
            last_success_at = ?,
            last_error = NULL,
            last_etag = ?,
            last_modified = ?,
            last_body_hash = ?
        WHERE id = ?
      `).run(
        nowIso,
        nowIso,
        (response.headers.etag as string | undefined) || sub.last_etag || null,
        (response.headers['last-modified'] as string | undefined) || sub.last_modified || null,
        hash,
        subscriptionId,
      );

      // Fast path when body hash didn't change and we already have a snapshot.
      if (sub.last_body_hash && sub.last_body_hash === hash) {
        return;
      }

      const parsed = ICAL.parse(body);
      const vcal = new ICAL.Component(parsed);
      const vevents = vcal.getAllSubcomponents('vevent');
      const seenAt = new Date().toISOString();

      const upsert = db.prepare(`
        INSERT INTO subscription_events (
          subscription_id, uid, recurrence_id, summary, start_at, end_at,
          location, description, all_day, timezone, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(subscription_id, uid, recurrence_id) DO UPDATE SET
          summary = excluded.summary,
          start_at = excluded.start_at,
          end_at = excluded.end_at,
          location = excluded.location,
          description = excluded.description,
          all_day = excluded.all_day,
          timezone = excluded.timezone,
          last_seen_at = excluded.last_seen_at
      `);

      const applySnapshot = db.transaction(() => {
        for (const vevent of vevents) {
          const uid = vevent.getFirstPropertyValue('uid') as string | null;
          const dtStart = vevent.getFirstPropertyValue('dtstart') as ICAL.Time | null;
          const dtEnd = vevent.getFirstPropertyValue('dtend') as ICAL.Time | null;
          if (!uid || !dtStart || !dtEnd) continue;

          const recurrenceId = (vevent.getFirstPropertyValue('recurrence-id') as ICAL.Time | null)?.toString() || '';
          const summary = (vevent.getFirstPropertyValue('summary') as string | null) || '';
          const location = (vevent.getFirstPropertyValue('location') as string | null) || null;
          const description = (vevent.getFirstPropertyValue('description') as string | null) || null;
          const timezone = dtStart.zone?.tzid || null;

          upsert.run(
            subscriptionId,
            uid,
            recurrenceId,
            summary,
            dtStart.toJSDate().toISOString(),
            dtEnd.toJSDate().toISOString(),
            location,
            description,
            dtStart.isDate ? 1 : 0,
            timezone,
            seenAt,
          );
        }

        // Authoritative snapshot: delete rows not seen in this fetch.
        db.prepare('DELETE FROM subscription_events WHERE subscription_id = ? AND last_seen_at <> ?').run(subscriptionId, seenAt);
      });

      applySnapshot();
    } catch (err: any) {
      const safeMessage = err?.response?.status ? `Fetch failed with HTTP ${err.response.status}` : `Fetch failed: ${err?.message || 'unknown error'}`;
      db.prepare('UPDATE calendar_subscriptions SET last_fetched_at = ?, last_error = ? WHERE id = ?').run(nowIso, safeMessage, subscriptionId);
      throw new Error(safeMessage);
    }
  }

  async fetchDueSubscriptions(): Promise<void> {
    const subs = db
      .prepare('SELECT id, update_frequency_minutes, last_fetched_at FROM calendar_subscriptions WHERE enabled = 1')
      .all() as Array<{ id: string; update_frequency_minutes: number; last_fetched_at: string | null }>;

    for (const sub of subs) {
      if (!this.shouldFetch(sub)) continue;
      try {
        await this.fetchSubscription(sub.id);
      } catch (err: any) {
        console.warn(`Subscription sync failed for ${sub.id}: ${err?.message || err}`);
      }
    }
  }
}

export const subscriptionService = new SubscriptionService();
