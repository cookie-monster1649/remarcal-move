import { subscriptionService } from './subscriptionService';
import assert from 'assert';

function run() {
  console.log('running subscriptionService tests');

  testRecurringDoesNotShift();
  testOverlapMultiday();
  console.log('all tests passed');
}

// Event repeats daily at 09:00 UTC; make sure occurrences keep the 09:00 time
function testRecurringDoesNotShift() {
  const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:foo
DTSTART:20230101T090000Z
DTEND:20230101T100000Z
RRULE:FREQ=DAILY;COUNT=3
SUMMARY:Daily at nine
END:VEVENT
END:VCALENDAR`;

  const windowStart = new Date('2023-01-01T00:00:00Z');
  const windowEnd = new Date('2023-01-05T00:00:00Z');
  const occurrences = subscriptionService.parseICSEvents(ics, windowStart, windowEnd);
  assert.strictEqual(occurrences.length, 3, 'should expand three occurrences');
  occurrences.forEach((o, idx) => {
    const expected = new Date(`2023-01-0${idx + 1}T09:00:00.000Z`).toISOString();
    assert.strictEqual(o.start.toISOString(), expected, `occurrence ${idx} wrong start`);
  });
}

// event spans midnight; it should appear for both days in the window
function testOverlapMultiday() {
  const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:bar
DTSTART:20230101T230000Z
DTEND:20230102T010000Z
RRULE:FREQ=DAILY;COUNT=2
SUMMARY:Late night
END:VEVENT
END:VCALENDAR`;

  const windowStart = new Date('2023-01-01T00:00:00Z');
  const windowEnd = new Date('2023-01-03T00:00:00Z');
  const occurrences = subscriptionService.parseICSEvents(ics, windowStart, windowEnd);
  assert.strictEqual(occurrences.length, 2, 'should yield two recurrences');
  // first occurrence starts on Jan1 23:00
  assert.strictEqual(occurrences[0].start.toISOString(), '2023-01-01T23:00:00.000Z');
  // second occurrence should be Jan2 23:00
  assert.strictEqual(occurrences[1].start.toISOString(), '2023-01-02T23:00:00.000Z');
}

if (require.main === module) {
  run();
}
