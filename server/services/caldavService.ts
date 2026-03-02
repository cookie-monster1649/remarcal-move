import axios from 'axios';
import { parseStringPromise } from 'xml2js';
import ICAL from 'ical.js';
import { format, parseISO } from 'date-fns';

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
}

export interface CalendarInfo {
  url: string;
  name: string;
  color?: string;
}

export class CalDavService {
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

      const response = await axios({
        method: 'PROPFIND',
        url: url,
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'Depth': '1',
          'Authorization': authHeader,
          'User-Agent': 'Remarcal/1.0'
        },
        data: xmlBody,
        validateStatus: (status) => status < 500, // Handle 401/404 gracefully
      });

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

    // 1. Construct REPORT Request
    const start = format(parseISO(startDate), "yyyyMMdd'T'HHmmss'Z'");
    const end = format(parseISO(endDate), "yyyyMMdd'T'HHmmss'Z'");

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
      const response = await axios({
        method: 'REPORT',
        url: url,
        auth: username && password ? { username, password } : undefined,
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'Depth': '1'
        },
        data: xmlBody
      });

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

      for (const raw of rawEvents) {
        try {
          const jcalData = ICAL.parse(raw);
          const comp = new ICAL.Component(jcalData);
          
          // Try to get X-WR-TIMEZONE from the VCALENDAR component
          const wrTz = comp.getFirstPropertyValue('x-wr-timezone') as string;
          if (wrTz && !calendarTimezone) {
            calendarTimezone = wrTz;
          }

          const vevents = comp.getAllSubcomponents('vevent');

          for (const vevent of vevents) {
            const event = new ICAL.Event(vevent);

            const summary = event.summary;
            const location = event.location;
            const description = event.description;
            
            let startDate = event.startDate.toJSDate();
            let endDate = event.endDate.toJSDate();
            
            // Skip invalid dates
            if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
              console.warn('Skipping event with invalid date:', summary);
              continue;
            }

            const isAllDay = event.startDate.isDate;
            
            // Get the timezone of the event itself
            const eventTz = event.startDate.zone ? event.startDate.zone.tzid : undefined;
            if (eventTz && !calendarTimezone) {
              calendarTimezone = eventTz;
            }

            events.push({
              summary,
              start: startDate,
              end: endDate,
              location,
              description,
              allDay: isAllDay,
              timezone: eventTz
            });
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
