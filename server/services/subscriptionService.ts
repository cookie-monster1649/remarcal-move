import axios from 'axios';
import crypto from 'crypto';
import ICAL from 'ical.js';
import { fromZonedTime } from 'date-fns-tz';
import db from '../db.js';
import { decrypt } from './encryptionService.js';
import { traceConfig } from '../utils/traceConfig.js';

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

type ParticipationStatus = 'accepted' | 'declined' | 'tentative' | 'needs-action';

export class SubscriptionService {
  private readonly minFrequencyMinutes = 15;

  private readonly maxOccurrenceIterations = 20000;

  private traceLog(message: string, payload?: Record<string, unknown>) {
    if (!traceConfig.ingest) return;
    if (payload) {
      console.log(`[calendar-trace] ${message}`, payload);
      return;
    }
    console.log(`[calendar-trace] ${message}`);
  }

  private toComponent(componentLike: ICAL.Component | ICAL.Event | null | undefined): ICAL.Component | null {
    if (!componentLike) return null;

    const maybeEvent = componentLike as any;
    if (maybeEvent?.component && typeof maybeEvent.component.getFirstPropertyValue === 'function') {
      return maybeEvent.component as ICAL.Component;
    }

    if (typeof (componentLike as any).getFirstPropertyValue === 'function') {
      return componentLike as ICAL.Component;
    }

    return null;
  }

  private getFirstPropertyValue(
    componentLike: ICAL.Component | ICAL.Event | null | undefined,
    propertyName: string,
  ): string | null {
    const component = this.toComponent(componentLike);
    if (!component || typeof (component as any).getFirstPropertyValue !== 'function') return null;
    return (component.getFirstPropertyValue(propertyName) as string | null) ?? null;
  }

  private isCancelled(componentLike: ICAL.Component | ICAL.Event | null | undefined): boolean {
    const status = this.getFirstPropertyValue(componentLike, 'status')?.toUpperCase();
    return status === 'CANCELLED' || status === 'CANCELED';
  }

  private normalizeParticipationStatus(value: string | null | undefined): ParticipationStatus | null {
    const normalized = String(value || '').trim().toUpperCase();
    if (!normalized) return null;
    if (normalized === 'ACCEPTED') return 'accepted';
    if (normalized === 'DECLINED') return 'declined';
    if (normalized === 'TENTATIVE') return 'tentative';
    if (normalized === 'NEEDS-ACTION' || normalized === 'NEEDSACTION') return 'needs-action';
    return null;
  }

  private extractParticipationStatus(componentLike: ICAL.Component | ICAL.Event | null | undefined): ParticipationStatus | null {
    const component = this.toComponent(componentLike);
    if (!component) return null;

    const attendees = component.getAllProperties('attendee') || [];
    const statuses = attendees
      .map((attendee) => this.normalizeParticipationStatus(attendee.getParameter('partstat') as string | null | undefined))
      .filter((v): v is ParticipationStatus => !!v);

    if (statuses.includes('declined')) return 'declined';
    if (statuses.includes('tentative')) return 'tentative';
    if (statuses.includes('accepted')) return 'accepted';
    if (statuses.includes('needs-action')) return 'needs-action';

    return null;
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

  private validDateRange(start: Date, end: Date): boolean {
    const startMs = start.getTime();
    const endMs = end.getTime();
    return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs;
  }

  private normalizeTimezoneId(tzid: string | null | undefined): string | null {
    if (!tzid) return null;
    const raw = String(tzid).trim();
    if (!raw) return null;

    if (raw.toUpperCase() === 'UTC' || raw.toUpperCase() === 'Z') return 'UTC';

    const withoutPrefix = raw.replace(/^UTC/i, '').replace(/^GMT/i, '').trim();
    const offsetMatch = withoutPrefix.match(/^([+-]?)(\d{1,2})(?::?(\d{2}))?$/);
    if (offsetMatch) {
      const sign = offsetMatch[1] || '+';
      const hh = offsetMatch[2].padStart(2, '0');
      const mm = (offsetMatch[3] || '00').padStart(2, '0');
      return `${sign}${hh}:${mm}`;
    }

    return raw;
  }

  private isOffsetTimezoneId(tzid: string | null | undefined): boolean {
    if (!tzid) return false;
    return /^[+-]\d{2}:\d{2}$/.test(tzid);
  }

  private resolveTimezoneId(eventTzid: string | null, calendarTzid: string | null): string | null {
    if (!eventTzid) return calendarTzid || null;
    if (!calendarTzid) return eventTzid;

    // Some feeds expose per-event fixed offsets (e.g. +10:30) while the calendar
    // itself defines the intended local timezone (e.g. UTC+11 / Australia/Melbourne).
    // Prefer the calendar timezone in that case to preserve expected wall-clock time.
    if (this.isOffsetTimezoneId(eventTzid) && eventTzid !== calendarTzid) {
      return calendarTzid;
    }

    return eventTzid;
  }

  private getPropertyTimezoneId(
    componentLike: ICAL.Component | ICAL.Event | null | undefined,
    propertyName: string,
  ): string | null {
    const component = this.toComponent(componentLike);
    const prop = component?.getFirstProperty(propertyName);
    const tzid = prop?.getParameter('tzid') as string | undefined;
    return this.normalizeTimezoneId(tzid || null);
  }

  private toEventDate(time: ICAL.Time | null | undefined, explicitTzid?: string | null): Date | null {
    if (!time) return null;

    const year = Number((time as any).year);
    const month = Number((time as any).month);
    const day = Number((time as any).day);
    const hour = Number((time as any).hour || 0);
    const minute = Number((time as any).minute || 0);
    const second = Number((time as any).second || 0);

    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;

    const tzid = this.normalizeTimezoneId(explicitTzid || (time as any).zone?.tzid || null);

    // For date-only values, persist as UTC midnight on that date.
    if (time.isDate) {
      return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
    }

    const pad = (n: number) => String(n).padStart(2, '0');
    const localIso = `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;

    // Floating values should preserve wall-clock fields (no zone conversion).
    if (tzid === 'floating') {
      return new Date(Date.UTC(year, month - 1, day, hour, minute, second, 0));
    }

    // Explicit UTC values map directly from wall-clock fields to UTC.
    if (tzid === 'UTC') {
      return new Date(Date.UTC(year, month - 1, day, hour, minute, second, 0));
    }

    // TZID-based values: interpret the local wall-clock in that timezone.
    if (tzid) {
      try {
        const converted = fromZonedTime(localIso, tzid);
        if (Number.isFinite(converted.getTime())) return converted;
      } catch {
        // Ignore and continue to native / stable UTC-field fallback below.
      }
    }

    // Fallback to ical.js conversion for unusual zone representations.
    const native = time.toJSDate();
    if (Number.isFinite(native.getTime())) {
      return native;
    }

    // Final fallback: preserve wall-clock fields to avoid collapsing timed events to one slot.
    return new Date(Date.UTC(year, month - 1, day, hour, minute, second, 0));
  }

  private recurrenceKey(details: { recurrenceId?: ICAL.Time | null; startDate: ICAL.Time }, sourceTzid: string | null): string {
    const reference = details.recurrenceId || details.startDate;
    const asDate = this.toEventDate(reference, sourceTzid);
    if (asDate && Number.isFinite(asDate.getTime())) {
      return asDate.toISOString();
    }
    return reference.toString();
  }

  /**
   * Parse an iCalendar feed and expand all component instances that overlap the
   * provided window.  The returned array mirrors the shape of rows inserted into
   * the `subscription_events` table and is exposed for unit testing.
   */
  public parseICSEvents(
    body: string,
    rangeStart: Date,
    rangeEnd: Date,
  ): Array<{
    uid: string;
    recurrenceId: string;
    summary: string;
    start: Date;
    end: Date;
    location: string | null;
    description: string | null;
    allDay: boolean;
    timezone: string | null;
    participationStatus: ParticipationStatus | null;
  }> {
    const parsed = ICAL.parse(body);
    const vcal = new ICAL.Component(parsed);
    const vevents = vcal.getAllSubcomponents('vevent');
    const firstVtimezone = vcal.getFirstSubcomponent('vtimezone');
    const calendarTimezone = this.normalizeTimezoneId(
      this.getFirstPropertyValue(vcal, 'x-wr-timezone')
      || this.getFirstPropertyValue(vcal, 'timezone-id')
      || this.getFirstPropertyValue(firstVtimezone, 'tzid')
      || null,
    );

    const eventsByUid = new Map<string, ICAL.Event>();
    const pendingExceptionsByUid = new Map<string, ICAL.Component[]>();

    for (const vevent of vevents) {
      const uid = vevent.getFirstPropertyValue('uid') as string | null;
      if (!uid) continue;

      let event: ICAL.Event;
      try {
        event = new ICAL.Event(vevent);
      } catch {
        continue;
      }

      const recurrenceId = vevent.getFirstPropertyValue('recurrence-id');
      if (recurrenceId) {
        const base = eventsByUid.get(uid);
        if (base) {
          base.relateException(vevent);
        } else {
          const list = pendingExceptionsByUid.get(uid) || [];
          list.push(vevent);
          pendingExceptionsByUid.set(uid, list);
        }
        continue;
      }

      eventsByUid.set(uid, event);
      const queued = pendingExceptionsByUid.get(uid);
      if (queued && queued.length) {
        queued.forEach((ex) => event.relateException(ex));
        pendingExceptionsByUid.delete(uid);
      }
    }

    const output: Array<any> = [];

    for (const event of eventsByUid.values()) {
      const vevent = event.component;
      if (this.isCancelled(vevent)) continue;

      const uid = vevent.getFirstPropertyValue('uid') as string | null;
      if (!uid) continue;

      const summaryFallback = (vevent.getFirstPropertyValue('summary') as string | null) || '';
      const locationFallback = (vevent.getFirstPropertyValue('location') as string | null) || null;
      const descriptionFallback = (vevent.getFirstPropertyValue('description') as string | null) || null;

      const pushOccurrence = (details: any, sourceTzid: string | null, endTzid: string | null) => {
        const startDate = this.toEventDate(details.startDate, sourceTzid);
        const endDate = this.toEventDate(details.endDate, endTzid);
        if (!startDate || !endDate) return;
        if (!this.validDateRange(startDate, endDate)) return;
        if (startDate.getTime() > rangeEnd.getTime()) return;
        if (!this.overlaps(startDate, endDate, rangeStart, rangeEnd)) return;
        if (this.isCancelled(details.item)) return;

        const summary = this.getFirstPropertyValue(details.item, 'summary') || summaryFallback;
        const location = this.getFirstPropertyValue(details.item, 'location') || locationFallback;
        const description = this.getFirstPropertyValue(details.item, 'description') || descriptionFallback;
        const timezone = sourceTzid;
        const recurrenceId = this.recurrenceKey(details, sourceTzid);
        const participationStatus = this.extractParticipationStatus(details.item) || this.extractParticipationStatus(event.component);

        output.push({
          uid,
          recurrenceId,
          summary,
          start: startDate,
          end: endDate,
          location,
          description,
          allDay: details.startDate.isDate,
          timezone,
          participationStatus,
        });
      };

      if (event.isRecurring()) {
        const iterator = event.iterator(event.startDate);
        let guard = 0;
        while (true) {
          guard++;
          if (guard > this.maxOccurrenceIterations) break;

          const next = iterator.next();
          if (!next) break;
          const details = event.getOccurrenceDetails(next);
          const item = details.item;
          const sourceTzid = this.resolveTimezoneId(
            this.normalizeTimezoneId(
              this.getPropertyTimezoneId(item, 'dtstart')
              || this.getPropertyTimezoneId(event.component, 'dtstart')
              || details.startDate.zone?.tzid
              || event.startDate.zone?.tzid
              || null,
            ),
            calendarTimezone,
          );
          const endTzid = this.resolveTimezoneId(
            this.normalizeTimezoneId(
              this.getPropertyTimezoneId(item, 'dtend')
              || this.getPropertyTimezoneId(event.component, 'dtend')
              || sourceTzid,
            ),
            calendarTimezone,
          );
          pushOccurrence(details, sourceTzid, endTzid);
        }
      } else {
        const sourceTzid = this.resolveTimezoneId(
          this.normalizeTimezoneId(
            this.getPropertyTimezoneId(vevent, 'dtstart')
            || event.startDate.zone?.tzid
            || null,
          ),
          calendarTimezone,
        );
        const endTzid = this.resolveTimezoneId(
          this.normalizeTimezoneId(
            this.getPropertyTimezoneId(vevent, 'dtend')
            || sourceTzid,
          ),
          calendarTimezone,
        );

        // create a pretend details object for single-instance events
        const details = { startDate: event.startDate, endDate: event.endDate, item: vevent };
        pushOccurrence(details, sourceTzid, endTzid);
      }
    }

    // include vfreebusy same as in fetchSubscription
    const vfreebusy = vcal.getAllSubcomponents('vfreebusy');
    for (const busyComponent of vfreebusy) {
      const uidBase = (busyComponent.getFirstPropertyValue('uid') as string | null) || `vfreebusy`;
      const organizer = (busyComponent.getFirstPropertyValue('organizer') as string | null) || null;
      const periods = this.freeBusyPeriods(busyComponent);

      periods.forEach((period, idx) => {
        if (!this.overlaps(period.start, period.end, rangeStart, rangeEnd)) return;
        output.push({
          uid: uidBase,
          recurrenceId: `vfreebusy-${idx}-${period.start.toISOString()}`,
          summary: organizer ? `Busy (${organizer})` : 'Busy',
          start: period.start,
          end: period.end,
          location: null,
          description: null,
          allDay: false,
          timezone: null,
          participationStatus: null,
        });
      });
    }

    return output;
  }

  /**
   * Remove all stored events belonging to a subscription.  Useful when a
   * user deletes/re-adds a feed or wants to rebuild from scratch.
   */
  public clearSubscription(subscriptionId: string): void {
    db.prepare('DELETE FROM subscription_events WHERE subscription_id = ?').run(subscriptionId);
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

      this.traceLog('fetchSubscription:start', {
        subscriptionId,
        bodyLength: body.length,
        explicitWindow,
        rangeStart: rangeStart.toISOString(),
        rangeEnd: rangeEnd.toISOString(),
      });

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
      const firstVtimezone = vcal.getFirstSubcomponent('vtimezone');
      const calendarTimezone = this.normalizeTimezoneId(
        this.getFirstPropertyValue(vcal, 'x-wr-timezone')
        || this.getFirstPropertyValue(vcal, 'timezone-id')
        || this.getFirstPropertyValue(firstVtimezone, 'tzid')
        || null,
      );

      this.traceLog('fetchSubscription:parsed', {
        subscriptionId,
        veventCount: vevents.length,
        vfreebusyCount: vfreebusy.length,
        calendarTimezone,
      });

      // Build complete event sets by UID and deterministically link exceptions.
      const eventsByUid = new Map<string, ICAL.Event>();
      const pendingExceptionsByUid = new Map<string, ICAL.Component[]>();

      for (const vevent of vevents) {
        const uid = vevent.getFirstPropertyValue('uid') as string | null;
        if (!uid) continue;

        let event: ICAL.Event;
        try {
          event = new ICAL.Event(vevent);
        } catch {
          continue;
        }

        const recurrenceId = vevent.getFirstPropertyValue('recurrence-id');
        if (recurrenceId) {
          const base = eventsByUid.get(uid);
          if (base) {
            base.relateException(vevent);
          } else {
            const list = pendingExceptionsByUid.get(uid) || [];
            list.push(vevent);
            pendingExceptionsByUid.set(uid, list);
          }
          continue;
        }

        eventsByUid.set(uid, event);
        const queued = pendingExceptionsByUid.get(uid);
        if (queued && queued.length) {
          queued.forEach((ex) => event.relateException(ex));
          pendingExceptionsByUid.delete(uid);
        }
      }

      const seenAt = new Date().toISOString();
      const traceMaxRows = traceConfig.limit;
      let traceRows = 0;

      const upsert = db.prepare(`
        INSERT INTO subscription_events (
          subscription_id, uid, recurrence_id, summary, start_at, end_at,
          location, description, all_day, timezone, participation_status, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(subscription_id, uid, recurrence_id) DO UPDATE SET
          summary = excluded.summary,
          start_at = excluded.start_at,
          end_at = excluded.end_at,
          location = excluded.location,
          description = excluded.description,
          all_day = excluded.all_day,
          timezone = excluded.timezone,
          participation_status = excluded.participation_status,
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
            // When iterating recurring events we must not pass the sync window as the
            // iterator start time. ical.js treats the provided "start" as the
            // DTSTART for the whole series, which has the side‑effect of shifting the
            // wall‑clock time of every occurrence to match that value.  this was the
            // root cause of the previous bug where every recurring instance began at
            // the same time (the first moment of the range).
            //
            // Instead, begin from the event's actual DTSTART and simply skip any
            // occurrences that fall entirely before the requested window.  The guard
            // variable keeps us from iterating forever on wildly long series.
            const iterator = event.iterator(event.startDate);
            let guard = 0;

            while (true) {
              guard++;
              if (guard > this.maxOccurrenceIterations) break;

              const next = iterator.next();
              if (!next) break;

              const details = event.getOccurrenceDetails(next);
              const item = details.item;
              const sourceTzid = this.resolveTimezoneId(
                this.normalizeTimezoneId(
                this.getPropertyTimezoneId(item, 'dtstart')
                || this.getPropertyTimezoneId(event.component, 'dtstart')
                || details.startDate.zone?.tzid
                || event.startDate.zone?.tzid
                || null,
                ),
                calendarTimezone,
              );
              const endTzid = this.resolveTimezoneId(
                this.normalizeTimezoneId(
                this.getPropertyTimezoneId(item, 'dtend')
                || this.getPropertyTimezoneId(event.component, 'dtend')
                || sourceTzid,
                ),
                calendarTimezone,
              );

              const startDate = this.toEventDate(details.startDate, sourceTzid);
              const endDate = this.toEventDate(details.endDate, endTzid);
              if (!startDate || !endDate) continue;
              if (!this.validDateRange(startDate, endDate)) continue;
              if (startDate.getTime() > rangeEnd.getTime()) break;

              // drop occurrences that only exist completely before the window
              if (!this.overlaps(startDate, endDate, rangeStart, rangeEnd)) continue;

              if (this.isCancelled(item)) continue;

              const summary = this.getFirstPropertyValue(item, 'summary') || summaryFallback;
              const location = this.getFirstPropertyValue(item, 'location') || locationFallback;
              const description = this.getFirstPropertyValue(item, 'description') || descriptionFallback;
              const timezone = sourceTzid;
              const recurrenceId = this.recurrenceKey(details, sourceTzid);
              const participationStatus = this.extractParticipationStatus(item) || this.extractParticipationStatus(event.component);

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
                participationStatus,
                seenAt,
              );

              if (traceConfig.ingest && traceRows < traceMaxRows) {
                traceRows++;
                this.traceLog('occurrence:upsert', {
                  subscriptionId,
                  uid,
                  recurrenceId,
                  startAt: startDate.toISOString(),
                  endAt: endDate.toISOString(),
                  timezone,
                  allDay: details.startDate.isDate,
                });
              }
            }
            continue;
          }

          const sourceTzid = this.resolveTimezoneId(
            this.normalizeTimezoneId(
            this.getPropertyTimezoneId(vevent, 'dtstart')
            || event.startDate.zone?.tzid
            || null,
            ),
            calendarTimezone,
          );
          const endTzid = this.resolveTimezoneId(
            this.normalizeTimezoneId(
            this.getPropertyTimezoneId(vevent, 'dtend')
            || sourceTzid,
            ),
            calendarTimezone,
          );

          const startDate = this.toEventDate(event.startDate, sourceTzid);
          const endDate = this.toEventDate(event.endDate, endTzid);
          if (!startDate || !endDate) continue;
          if (!this.validDateRange(startDate, endDate)) continue;
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
            sourceTzid,
            this.extractParticipationStatus(vevent),
            seenAt,
          );

          if (traceConfig.ingest && traceRows < traceMaxRows) {
            traceRows++;
            this.traceLog('single-event:upsert', {
              subscriptionId,
              uid,
              recurrenceId: '',
              startAt: startDate.toISOString(),
              endAt: endDate.toISOString(),
              timezone: sourceTzid,
              allDay: event.startDate.isDate,
            });
          }
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

        if (traceConfig.ingest) {
          const summary = db.prepare(`
            SELECT
              COUNT(*) AS total,
              COUNT(DISTINCT start_at) AS distinct_starts,
              MIN(start_at) AS min_start,
              MAX(start_at) AS max_start
            FROM subscription_events
            WHERE subscription_id = ?
          `).get(subscriptionId) as any;

          this.traceLog('fetchSubscription:db-summary', {
            subscriptionId,
            total: summary?.total ?? 0,
            distinctStarts: summary?.distinct_starts ?? 0,
            minStart: summary?.min_start ?? null,
            maxStart: summary?.max_start ?? null,
          });
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
