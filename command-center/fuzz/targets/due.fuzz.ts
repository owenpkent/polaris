import { dueDay, formatDue, isDateOnly, parseDueInput, toLocalDue } from '../../src/core/dueAt.ts';
import { isDueInputError, rethrowUnless } from './expected.ts';

const TIMEZONES = ['UTC', 'Europe/London', 'America/New_York', 'Asia/Kolkata', 'Australia/Lord_Howe', 'Pacific/Chatham'];

// Due dates as typed on the command line, as shown, and as a zoned moment becomes floating local
// time. The first byte picks the timezone; the rest is the value. parseDueInput may refuse a time
// of day out of range, with one message; everything else is total. toLocalDue and formatDue must
// each be a fixed point on their own output, or a value would drift every time it is saved.
export function fuzz(data: Buffer): void {
  const tz = TIMEZONES[(data[0] ?? 0) % TIMEZONES.length];
  const text = data.subarray(1).toString('utf8');
  try {
    parseDueInput(text);
  } catch (err) {
    rethrowUnless(err, isDueInputError);
  }
  const shown = formatDue(text);
  if (formatDue(shown) !== shown) throw new Error(`formatDue drifts: ${JSON.stringify(text)} -> ${JSON.stringify(shown)} -> ${JSON.stringify(formatDue(shown))}`);
  const local = toLocalDue(text, tz);
  if (toLocalDue(local, tz) !== local) throw new Error(`toLocalDue drifts in ${tz}: ${JSON.stringify(text)} -> ${JSON.stringify(local)} -> ${JSON.stringify(toLocalDue(local, tz))}`);
  if (isDateOnly(text) && dueDay(text) !== text) throw new Error(`dueDay changes a day: ${text}`);
}
