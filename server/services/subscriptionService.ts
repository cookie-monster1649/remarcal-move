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

type FetchWindow = {
  rangeStart?: Date;
  rangeEnd?: Date;
};

export class SubscriptionService {
  private readonly minFrequencyMinutes = 15;

  private toComponent(componentLike: ICAL.Component | ICAL.Event | null | undefined): ICAL.Component | null {
    if (!componentLike) return null;
    return componentLike instanceof ICAL.Event ? componentLike.component : componentLike;
  }

  private getFirstPropertyValue(
    componentLike: ICAL.Component | ICAL.Event | null | undefined,
    propertyName: string,
  ): string | null {
    const component = this.toComponent(componentLike);
    return (component?.getFirstPropertyValue(propertyName) as string | null) ?? null;
  }

  private isCancelled(componentLike: ICAL.Component | ICAL.Event | null | undefined): boolean {
    const status = this.getFirstPropertyValue(componentLike, 'status')?.toUpperCase();
    return status === 'CANCELLED';
  }

  private linkedDocumentsWindow(subscriptionId: string): { start: Date; end: Date } | null {
    const row = db.prepare(`
      SELECT MIN(d.year) AS min_year, MAX(d.year) AS max_year
      FROM documents d
      JOIN document_subscriptions ds ON d.id = ds.document_id
      WHERE ds.subscription_id = ?
    `).get(subscriptionId) as { min_year: number | null; max_year: number | null } | undefined;

    const minYear = row?.min_year;
    const maxYear = row?.max_year;
    if (!minYear || !maxYear) return null;

    return {
      start: new Date(Date.UTC(minYear, 0, 1, 0, 0, 0, 0)),
      end: new Date(Date.UTC(maxYear, 11, 31, 23, 59, 59, 999)),
    };
  }

  private defaultWindow(): { start: Date; end: Date } {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1, 0, 0, 0, 0));
    const end = new Date(Date.UTC(now.getUTCFullYear() + 2, 11, 31, 23, 59, 59, 999));
    return { start, end };
  }

  private toIcalTime(date: Date): ICAL.Time {
    return ICAL.Time.fromJSDate(date, true);
  }

  private overlaps(start: Date, end: Date, rangeStart: Date, rangeEnd: Date): boolean {
    return end.getTime() >= rangeStart.getTime() && start.getTime() <= rangeEnd.getTime();
  }

  private freeBusyPeriods(component: ICAL.Component): Array<{ start: Date; end: Date }> {
    const periods: Array<{ start: Date; end: Date }> = [];
    const properties = component.getAllProperties('freebusy');

    for (const prop of properties) {
      const values = (prop as any).getValues?.() || [];
      for (const value of values) {
        const startTime = value?.start as ICAL.Time | undefined;
        const endTime = value?.end as ICAL.Time | undefined;
        if (!startTime || !endTime) continue;
        const start = startTime.toJSDate();
        const end = endTime.toJSDate();
        if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) continue;
        periods.push({ start, end });
      }
    }

    return periods;
  }

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

  async fetchSubscription(subscriptionId: string, window: FetchWindow = {}): Promise<void> {
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

    const explicitWindow = !!window.rangeStart || !!window.rangeEnd;
    const linkedWindow = this.linkedDocumentsWindow(subscriptionId);
    const defaultWindow = this.defaultWindow();
    const rangeStart = window.rangeStart ?? linkedWindow?.start ?? defaultWindow.start;
    const rangeEnd = window.rangeEnd ?? linkedWindow?.end ?? defaultWindow.end;

    try {
      const response = await axios.get(url, {
        responseType: 'text',
        timeout: 30000,
        maxContentLength: 10 * 1024 * 1024,
        maxBodyLength: 10 * 1024 * 1024,
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

      // Fast path when body hash didn't change and no explicit range sync was requested.
      // When an explicit window is requested (document-year sync), we still expand again so
      // newly requested ranges get materialized even if ICS body is unchanged.
      if (!explicitWindow && sub.last_body_hash && sub.last_body_hash === hash) {
        return;
      }

      const parsed = ICAL.parse(body);
      const vcal = new ICAL.Component(parsed);
      const vevents = vcal.getAllSubcomponents('vevent');
      const vfreebusy = vcal.getAllSubcomponents('vfreebusy');

      // Build complete events with linked recurrence exceptions.
      const eventsByUid = new Map<string, ICAL.Event>();
      const pendingExceptions = new Map<string, ICAL.Event[]>();
      for (const vevent of vevents) {
        const uid = vevent.getFirstPropertyValue('uid') as string | null;
        if (!uid) continue;
        const event = new ICAL.Event(vevent);

        if (event.isRecurrenceException()) {
          const base = eventsByUid.get(uid);
          if (base) {
            base.relateException(event);
          } else {
            const list = pendingExceptions.get(uid) || [];
            list.push(event);
            pendingExceptions.set(uid, list);
          }
          continue;
        }

        eventsByUid.set(uid, event);
        const queued = pendingExceptions.get(uid);
        if (queued && queued.length) {
          queued.forEach((ex) => event.relateException(ex));
          pendingExceptions.delete(uid);
        }
      }

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
        for (const event of eventsByUid.values()) {
          const vevent = event.component;
          if (this.isCancelled(vevent)) continue;

          const uid = vevent.getFirstPropertyValue('uid') as string | null;
          if (!uid) continue;

          const summaryFallback = (vevent.getFirstPropertyValue('summary') as string | null) || '';
          const locationFallback = (vevent.getFirstPropertyValue('location') as string | null) || null;
          const descriptionFallback = (vevent.getFirstPropertyValue('description') as string | null) || null;

          if (event.isRecurring()) {
            const iterator = event.iterator(this.toIcalTime(rangeStart));

            while (true) {
              const next = iterator.next();
              if (!next) break;

              const details = event.getOccurrenceDetails(next);
              const startDate = details.startDate.toJSDate();
              const endDate = details.endDate.toJSDate();
              if (startDate.getTime() > rangeEnd.getTime()) break;
              if (!this.overlaps(startDate, endDate, rangeStart, rangeEnd)) continue;

              const item = details.item;
              if (this.isCancelled(item)) continue;

              const summary = this.getFirstPropertyValue(item, 'summary') || summaryFallback;
              const location = this.getFirstPropertyValue(item, 'location') || locationFallback;
              const description = this.getFirstPropertyValue(item, 'description') || descriptionFallback;
              const timezone = details.startDate.zone?.tzid || null;
              const recurrenceId = details.recurrenceId ? details.recurrenceId.toString() : details.startDate.toString();

              upsert.run(
                subscriptionId,
                uid,
                recurrenceId,
                summary,
                startDate.toISOString(),
                endDate.toISOString(),
                location,
                description,
                details.startDate.isDate ? 1 : 0,
                timezone,
                seenAt,
              );
            }
            continue;
          }

          const startDate = event.startDate.toJSDate();
          const endDate = event.endDate.toJSDate();
          if (!this.overlaps(startDate, endDate, rangeStart, rangeEnd)) continue;

          upsert.run(
            subscriptionId,
            uid,
            '',
            summaryFallback,
            startDate.toISOString(),
            endDate.toISOString(),
            locationFallback,
            descriptionFallback,
            event.startDate.isDate ? 1 : 0,
            event.startDate.zone?.tzid || null,
            seenAt,
          );
        }

        // Include VFREEBUSY periods as synthetic events when present in feed.
        for (const busyComponent of vfreebusy) {
          const uidBase = (busyComponent.getFirstPropertyValue('uid') as string | null) || `vfreebusy-${subscriptionId}`;
          const organizer = (busyComponent.getFirstPropertyValue('organizer') as string | null) || null;
          const periods = this.freeBusyPeriods(busyComponent);

          periods.forEach((period, idx) => {
            if (!this.overlaps(period.start, period.end, rangeStart, rangeEnd)) return;

            upsert.run(
              subscriptionId,
              uidBase,
              `vfreebusy-${idx}-${period.start.toISOString()}`,
              organizer ? `Busy (${organizer})` : 'Busy',
              period.start.toISOString(),
              period.end.toISOString(),
              null,
              null,
              0,
              null,
              seenAt,
            );
          });
        }

        // Authoritative snapshot: delete rows not seen in this fetch.
        // If a specific window was requested (e.g. document year), only prune rows in that same window.
        if (explicitWindow) {
          db.prepare(`
            DELETE FROM subscription_events
            WHERE subscription_id = ?
              AND last_seen_at <> ?
              AND end_at >= ?
              AND start_at <= ?
          `).run(subscriptionId, seenAt, rangeStart.toISOString(), rangeEnd.toISOString());
        } else {
          db.prepare('DELETE FROM subscription_events WHERE subscription_id = ? AND last_seen_at <> ?').run(subscriptionId, seenAt);
        }
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
