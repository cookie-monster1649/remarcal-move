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
}

export interface CalendarInfo {
  url: string;
  name: string;
  color?: string;
}

export class CalDavService {
  async discoverCalendars(config: Partial<CalDavConfig>): Promise<CalendarInfo[]> {
    const { url, username, password } = config;
    if (!url) throw new Error('URL is required for discovery');

    const xmlBody = `
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
      const response = await axios({
        method: 'PROPFIND',
        url: url,
        auth: username && password ? { username, password } : undefined,
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'Depth': '1'
        },
        data: xmlBody
      });

      const result = await parseStringPromise(response.data, {
        tagNameProcessors: [(name) => {
          const parts = name.split(':');
          return parts.length > 1 ? parts[1] : name;
        }],
        explicitArray: false,
        mergeAttrs: true
      });

      const calendars: CalendarInfo[] = [];
      const responses = Array.isArray(result.multistatus.response) 
        ? result.multistatus.response 
        : [result.multistatus.response];

      for (const r of responses) {
        const prop = r.propstat?.prop || r.prop;
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
      console.error('CalDAV Discovery Error:', error.message);
      throw new Error(`CalDAV discovery failed: ${error.message}`);
    }
  }

  async fetchEvents(config: CalDavConfig): Promise<CalendarEvent[]> {
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
          // calendar-data might be an object with text content or just a string
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

      for (const raw of rawEvents) {
        try {
          const jcalData = ICAL.parse(raw);
          const comp = new ICAL.Component(jcalData);
          const vevents = comp.getAllSubcomponents('vevent');

          for (const vevent of vevents) {
            const event = new ICAL.Event(vevent);

            // Handle Recurrence Expansion if needed (simplified for now: just the base event or expanded instances if server returns them)
            // Note: CalDAV servers usually expand recurrences in REPORT responses if requested, but here we rely on the server sending expanded instances or just the base.
            // For a robust implementation, we might need client-side expansion, but let's start simple.

            const summary = event.summary;
            const location = event.location;
            const description = event.description;
            
            let startDate = event.startDate.toJSDate();
            let endDate = event.endDate.toJSDate();
            const isAllDay = event.startDate.isDate; // True if just date (no time)

            events.push({
              summary,
              start: startDate,
              end: endDate,
              location,
              description,
              allDay: isAllDay
            });
          }
        } catch (e) {
          console.warn('Failed to parse iCal data:', e);
        }
      }

      return events;

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
