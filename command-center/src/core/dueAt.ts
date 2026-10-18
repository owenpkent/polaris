// Due dates and due times. A task's dueAt is 'YYYY-MM-DD' (a day) or, with a time, an ISO
// datetime. The dashboard and the CLI write a time as floating local time, 'YYYY-MM-DDTHH:MM' with
// no zone: nine in the morning wherever the owner is. Every day-level question (is it overdue, is
// it due today, which digest section) is answered on the first ten characters, so a task due at a
// time behaves as its day; the time only orders tasks within that day, untimed ones first, which
// plain string order already does ('2026-10-18' < '2026-10-18T09:00' < '2026-10-19').

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
// What a person types: a day, then a space or a T, then HH:MM.
const TYPED = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/;

/** The day a due date falls on: its 'YYYY-MM-DD'. */
export function dueDay(dueAt: string): string {
  return dueAt.slice(0, 10);
}

/** True when the value is a plain 'YYYY-MM-DD' day with no time. */
export function isDateOnly(value: string): boolean {
  return DATE_ONLY.test(value);
}

/**
 * A due date for people to read: the day alone, or the day and the time with a space between
 * ('2026-10-18 09:00'). Zero seconds are left out; other seconds and a zone the value carries are
 * kept, so nothing is hidden. Anything else comes back unchanged.
 */
export function formatDue(dueAt: string): string {
  const m = DATETIME.exec(dueAt);
  if (!m) return dueAt;
  const [, day, hm, seconds, zone] = m;
  const keepSeconds = seconds && !/^:00(?:\.0+)?$/.test(seconds) ? seconds : '';
  return `${day} ${hm}${keepSeconds}${zone ? ` ${zone}` : ''}`;
}

/**
 * A due date as typed on the command line: 'YYYY-MM-DD', or 'YYYY-MM-DD HH:MM' (a T works in
 * place of the space), stored as 'YYYY-MM-DDTHH:MM'. Anything else is passed through for the store
 * to accept or refuse, so a full ISO datetime still works.
 */
export function parseDueInput(raw: string): string {
  const v = raw.trim();
  const m = TYPED.exec(v);
  if (!m) return v;
  const hour = Number(m[2]);
  const minute = Number(m[3]);
  if (hour > 23 || minute > 59) throw new Error(`"${raw}" is not a time of day. Use YYYY-MM-DD HH:MM, 24-hour.`);
  return `${m[1]}T${String(hour).padStart(2, '0')}:${m[3]}`;
}
