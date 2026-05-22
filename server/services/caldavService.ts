import axios from 'axios';
import { parseStringPromise } from 'xml2js';
import ICAL from 'ical.js';
import { retryHttpRequest } from '../utils/httpRetry.js';

export interface CalDavConfig {
  url: string;
  username?: string;
  password?: string;
  startDate: string;
  endDate: string;
}

export interface CalendarEvent {
  summary: string;
  start: Date;
  end: Date;
  location?: string;
  description?: string;
  allDay?: boolean;
  timezone?: string;
  uid?: string;
  recurrenceId?: string;
}

export interface CalendarInfo {
  url: string;
  name: string;
  color?: string;
}

export class CalDavService {
  private readonly timeoutMs = 30000;
  private readonly maxPayloadBytes = 10 * 1024 * 1024;

  async discoverCalendars(config: Partial<CalDavConfig> & { accountId?: string }): Promise<CalendarInfo[]> {
    let { url, username, password, accountId } = config;
    if (!url) throw new Error('URL is required for discovery');

    // Ensure trailing slash for collection discovery
    if (!url.endsWith('/')) {
      url += '/';
    }

    // If password is empty and accountId is provided, try to get from DB
    if (!password && accountId) {
      const db = (await import('../db.js')).default;
      const { decrypt } = await import('./encryptionService.js');
      const account = db.prepare('SELECT encrypted_password FROM caldav_accounts WHERE id = ?').get(accountId) as any;
      if (account) {
        password = decrypt(account.encrypted_password);
      }
    }

    const xmlBody = `<?xml version="1.0" encoding="utf-8" ?>
      <d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:prop>
          <d:displayname />
          <d:resourcetype />
          <c:calendar-description />
          <c:calendar-color xmlns:apple="http://apple.com/ns/ical/" />
        </d:prop>
      </d:propfind>
    `;

    try {
      const authHeader = username && password 
        ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
        : undefined;

      const response = await retryHttpRequest(
        () => axios({
          method: 'PROPFIND',
          url: url,
          timeout: this.timeoutMs,
          maxContentLength: this.maxPayloadBytes,
          maxBodyLength: this.maxPayloadBytes,
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Depth': '1',
            'Authorization': authHeader,
            'User-Agent': 'Remarcal/1.0'
          },
          data: xmlBody,
          validateStatus: (status) => status < 500, // 4xx is reported below; 5xx throws and retries.
        }),
        {
          onRetry: (err: any, attempt, delay) => {
            const status = err?.response?.status ?? err?.code ?? 'network';
            console.warn(`CalDAV PROPFIND retry ${attempt} (after ${delay}ms) — ${status}`);
          },
        },
      );

      if (response.status === 401) {
        throw new Error('Authentication failed (401). Please check your username and password.');
      }

      if (response.status === 404) {
        throw new Error('URL not found (404). Please check the CalDAV URL.');
      }

      if (response.status >= 400) {
        throw new Error(`Server returned error ${response.status}: ${response.statusText}`);
      }

      const result = await parseStringPromise(response.data, {
        tagNameProcessors: [(name) => {
          const parts = name.split(':');
          return parts.length > 1 ? parts[1] : name;
        }],
        explicitArray: false,
        mergeAttrs: true
      });

      const calendars: CalendarInfo[] = [];
      if (!result.multistatus || !result.multistatus.response) {
        return [];
      }

      const responses = Array.isArray(result.multistatus.response) 
        ? result.multistatus.response 
        : [result.multistatus.response];

      for (const r of responses) {
        // Handle propstat being an array or object
        let prop: any;
        if (r.propstat) {
          const propstats = Array.isArray(r.propstat) ? r.propstat : [r.propstat];
          // Find the one with status 200
          const okPropstat = propstats.find((ps: any) => ps.status && ps.status.includes('200'));
          prop = okPropstat?.prop || propstats[0]?.prop;
        } else {
          prop = r.prop;
        }

        if (!prop) continue;

        const resourcetype = prop.resourcetype;
        const isCalendar = resourcetype && (
          (resourcetype.calendar !== undefined) || 
          (Array.isArray(resourcetype) && resourcetype.some((t: any) => t.calendar !== undefined))
        );

        if (isCalendar) {
          let href = r.href;
          if (!href.startsWith('http')) {
            href = new URL(href, url).href;
          }

          calendars.push({
            url: href,
            name: prop.displayname || prop['calendar-description'] || href.split('/').filter(Boolean).pop() || 'Unnamed Calendar',
            color: prop['calendar-color']
          });
        }
      }

      return calendars;
    } catch (error: any) {
      if (error.response?.status === 401) {
        throw new Error('Authentication failed (401). Please check your username and password.');
      }
      console.error('CalDAV Discovery Error:', error.message);
      throw error;
    }
  }

  async fetchEvents(config: CalDavConfig): Promise<{ events: CalendarEvent[], timezone?: string }> {
    const { url, username, password, startDate, endDate } = config;

    // 1. Construct REPORT Request.
    // startDate/endDate are YYYY-MM-DD UTC dates. We build the iCal timestamps
    // directly to avoid two bugs in the previous `format(parseISO(...))` path:
    //   1. parseISO treats a date-only string as UTC midnight, but date-fns
    //      `format` formats local fields — so a UTC+11 client would send
    //      "20260101T110000Z" instead of "20260101T000000Z", silently dropping
    //      the first 11 hours of every range query.
    //   2. The end was emitted as "T000000Z", so events in the last 24 hours
    //      of the requested window were never returned.
    const start = `${startDate.replace(/-/g, '')}T000000Z`;
    const end = `${endDate.replace(/-/g, '')}T235959Z`;

    const xmlBody = `
      <c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
          <d:prop>
              <d:getetag />
              <c:calendar-data />
          </d:prop>
          <c:filter>
              <c:comp-filter name="VCALENDAR">
                  <c:comp-filter name="VEVENT">
                      <c:time-range start="${start}" end="${end}"/>
                  </c:comp-filter>
              </c:comp-filter>
          </c:filter>
      </c:calendar-query>
    `;

    try {
      const response = await retryHttpRequest(
        () => axios({
          method: 'REPORT',
          url: url,
          auth: username && password ? { username, password } : undefined,
          timeout: this.timeoutMs,
          maxContentLength: this.maxPayloadBytes,
          maxBodyLength: this.maxPayloadBytes,
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Depth': '1'
          },
          data: xmlBody
        }),
        {
          onRetry: (err: any, attempt, delay) => {
            const status = err?.response?.status ?? err?.code ?? 'network';
            console.warn(`CalDAV REPORT retry ${attempt} (after ${delay}ms) — ${status}`);
          },
        },
      );

      // 2. Parse XML Response
      const result = await parseStringPromise(response.data, {
        tagNameProcessors: [(name) => {
          const parts = name.split(':');
          return parts.length > 1 ? parts[1] : name;
        }],
        explicitArray: false,
        mergeAttrs: true
      });

      // 3. Extract iCal Data
      const rawEvents: string[] = [];
      const findCalendarData = (obj: any) => {
        if (!obj) return;
        if (obj['calendar-data']) {
          const data = typeof obj['calendar-data'] === 'object' ? obj['calendar-data']._ : obj['calendar-data'];
          if (data) rawEvents.push(data);
          return;
        }
        if (obj.response) {
           const responses = Array.isArray(obj.response) ? obj.response : [obj.response];
           responses.forEach((r: any) => findCalendarData(r));
           return;
        }
        if (obj.propstat) {
            const propstats = Array.isArray(obj.propstat) ? obj.propstat : [obj.propstat];
            propstats.forEach((p: any) => findCalendarData(p));
            return;
        }
        if (obj.prop) {
            findCalendarData(obj.prop);
            return;
        }
        if (obj.multistatus) {
            findCalendarData(obj.multistatus);
            return;
        }
      };

      findCalendarData(result);

      // 4. Parse iCal Data into CalendarEvent objects
      const events: CalendarEvent[] = [];
      let calendarTimezone: string | undefined;

      const rangeStartMs = new Date(`${startDate}T00:00:00.000Z`).getTime();
      const rangeEndMs = new Date(`${endDate}T23:59:59.999Z`).getTime();
      const MAX_OCCURRENCE_ITERATIONS = 20000;

      const isCancelled = (componentLike: ICAL.Component | ICAL.Event | null | undefined): boolean => {
        if (!componentLike) return false;
        const component = (componentLike as any).component instanceof ICAL.Component
          ? (componentLike as any).component as ICAL.Component
          : (componentLike as ICAL.Component);
        const status = (component.getFirstPropertyValue?.('status') as string | null | undefined)?.toUpperCase();
        return status === 'CANCELLED' || status === 'CANCELED';
      };

      for (const raw of rawEvents) {
        try {
          const jcalData = ICAL.parse(raw);
          const comp = new ICAL.Component(jcalData);

          const wrTz = comp.getFirstPropertyValue('x-wr-timezone') as string;
          if (wrTz && !calendarTimezone) {
            calendarTimezone = wrTz;
          }

          const vevents = comp.getAllSubcomponents('vevent');

          // Group by UID; relate RECURRENCE-ID exceptions to their master so that
          // ical.js can suppress the original occurrence and substitute the override.
          const eventsByUid = new Map<string, ICAL.Event>();
          const pendingExceptionsByUid = new Map<string, ICAL.Component[]>();

          for (const vevent of vevents) {
            const uid = vevent.getFirstPropertyValue('uid') as string | null;
            if (!uid) continue;

            const recurrenceId = vevent.getFirstPropertyValue('recurrence-id');
            if (recurrenceId) {
              const base = eventsByUid.get(uid);
              if (base) {
                base.relateException(vevent);
              } else {
                const pending = pendingExceptionsByUid.get(uid) || [];
                pending.push(vevent);
                pendingExceptionsByUid.set(uid, pending);
              }
              continue;
            }

            let event: ICAL.Event;
            try {
              event = new ICAL.Event(vevent);
            } catch {
              continue;
            }

            eventsByUid.set(uid, event);
            const queued = pendingExceptionsByUid.get(uid);
            if (queued?.length) {
              queued.forEach((ex) => event.relateException(ex));
              pendingExceptionsByUid.delete(uid);
            }
          }

          for (const event of eventsByUid.values()) {
            const vevent = event.component;
            const uid = vevent.getFirstPropertyValue('uid') as string | null;
            if (!uid) continue;

            // Whole series cancelled — skip every occurrence.
            if (isCancelled(vevent)) continue;

            const masterTz = event.startDate.zone?.tzid || undefined;
            if (masterTz && !calendarTimezone) {
              calendarTimezone = masterTz;
            }

            const pushOccurrence = (occItem: ICAL.Event, startTime: ICAL.Time, endTime: ICAL.Time) => {
              const start = startTime.toJSDate();
              const end = endTime.toJSDate();
              if (isNaN(start.getTime()) || isNaN(end.getTime())) return;
              if (end.getTime() < rangeStartMs || start.getTime() > rangeEndMs) return;

              // Per-instance cancellation: RECURRENCE-ID override with STATUS:CANCELLED.
              if (isCancelled(occItem)) return;

              const summary = occItem.summary || event.summary || '';
              const location = occItem.location || event.location || undefined;
              const description = occItem.description || event.description || undefined;
              const isAllDay = startTime.isDate;
              const timezone = occItem.startDate.zone?.tzid || masterTz;

              events.push({
                summary,
                start,
                end,
                location,
                description,
                allDay: isAllDay,
                timezone,
                uid,
                // Use start ISO as the per-occurrence unique key so the poller's
                // (uid, recurrence_id) upsert key stays unique across all instances.
                recurrenceId: start.toISOString(),
              });
            };

            if (event.isRecurring()) {
              const iterator = event.iterator(event.startDate);
              let guard = 0;
              while (guard++ < MAX_OCCURRENCE_ITERATIONS) {
                const next = iterator.next();
                if (!next) break;
                const details = event.getOccurrenceDetails(next);
                if (details.startDate.toJSDate().getTime() > rangeEndMs) break;
                pushOccurrence(details.item, details.startDate, details.endDate);
              }
            } else {
              pushOccurrence(event, event.startDate, event.endDate);
            }
          }
        } catch (e) {
          console.warn('Failed to parse iCal data:', e);
        }
      }

      return { events, timezone: calendarTimezone };

    } catch (error: any) {
      console.error('CalDAV Service Error:', error.message);
      if (error.response) {
          console.error('Response Status:', error.response.status);
          console.error('Response Data:', error.response.data);
      }
      throw new Error(`CalDAV fetch failed: ${error.message}`);
    }
  }
}
