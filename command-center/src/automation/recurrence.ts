// Recurrence: turn an RRULE (or a friendly alias) plus the due date of the last instance into
// the due date of the next instance.
//
// rrule ships as a CJS/UMD bundle with no package.json "exports" map, so under Node's ESM
// loader only a default export is visible (named exports are not statically detectable). We
// pull RRule off the default import rather than `import { RRule } from 'rrule'`.
import rrulePkg from 'rrule';

const { RRule } = rrulePkg;

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?$/;

/** Friendly recurrence aliases accepted in place of a raw RRULE string. */
const ALIASES: Record<string, string> = {
  daily: 'FREQ=DAILY',
  weekly: 'FREQ=WEEKLY',
  weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  monthly: 'FREQ=MONTHLY',
  yearly: 'FREQ=YEARLY',
};

const EVERY_N_RE = /^every\s+(\d+)\s+(day|days|week|weeks|month|months|year|years)$/;
const UNIT_FREQ: Record<string, string> = {
  day: 'DAILY', days: 'DAILY',
  week: 'WEEKLY', weeks: 'WEEKLY',
  month: 'MONTHLY', months: 'MONTHLY',
  year: 'YEARLY', years: 'YEARLY',
};

/**
 * Resolve a friendly alias ("weekly", "every 2 weeks") or a raw RRULE string (with or without a
 * leading "RRULE:") into a bare RRULE property string such as "FREQ=WEEKLY".
 */
function resolveAlias(input: string): string {
  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();
  if (ALIASES[lower]) return ALIASES[lower];
  const everyMatch = EVERY_N_RE.exec(lower);
  if (everyMatch) {
    const n = Number(everyMatch[1]);
    const freq = UNIT_FREQ[everyMatch[2]];
    return n > 1 ? `FREQ=${freq};INTERVAL=${n}` : `FREQ=${freq}`;
  }
  return trimmed.replace(/^RRULE:/i, '');
}

interface SplitDue {
  datePart: string;
  timePart: string | null;
  zonePart: string;
}

/** Split a due value into its date, time-of-day, and zone suffix, so we can preserve the shape on output. */
function splitDue(due: string): SplitDue {
  const dt = DATETIME_RE.exec(due);
  if (dt) return { datePart: dt[1], timePart: dt[2], zonePart: dt[3] ?? '' };
  if (DATE_ONLY_RE.test(due)) return { datePart: due, timePart: null, zonePart: '' };
  throw new Error(`invalid date '${due}': expected YYYY-MM-DD or an ISO datetime`);
}

// ---------------------------------------------------------------------------- the rule itself
//
// rrule is used to parse the string and for nothing else. Its iterator has no bound: when a rule
// never matches (BYMONTH=2 with BYMONTHDAY=30, or an INTERVAL that never lands on the day) it
// walks year by year to 9999, which for FREQ=DAILY is fifteen seconds of a blocked event loop,
// and UNTIL does not shorten that. A rule is validated on every task write, on the request
// thread, so expansion has to be work that always ends. This is a day-by-day walk over a fixed
// horizon for the subset a task tracker needs: the four calendar frequencies, INTERVAL, COUNT,
// UNTIL, BYMONTH, BYMONTHDAY, BYDAY (with a position for MONTHLY and YEARLY), and WKST. The parts
// that are refused are the ones with no meaning for a date-only due date (BYHOUR and below) or
// where a rule that never matches hides most easily (BYSETPOS, BYWEEKNO, BYYEARDAY). Where a rule
// is accepted, the walk agrees with rrule; recurrence.test.ts checks that against rrule itself.

const MAX_RULE_LENGTH = 200;
/** How far past the previous due date the walk looks before calling the series finished. */
const HORIZON_DAYS = 200 * 366;
const MAX_INTERVAL: Record<Freq, number> = { YEARLY: 10, MONTHLY: 120, WEEKLY: 53, DAILY: 366 };
const FREQ_NAMES = new Map<number, Freq>([[RRule.YEARLY, 'YEARLY'], [RRule.MONTHLY, 'MONTHLY'], [RRule.WEEKLY, 'WEEKLY'], [RRule.DAILY, 'DAILY']]);
const UNSUPPORTED_PARTS = ['bysetpos', 'byweekno', 'byyearday', 'byhour', 'byminute', 'bysecond', 'byeaster'] as const;
const UNSUPPORTED_NAMES: Record<(typeof UNSUPPORTED_PARTS)[number], string> = {
  bysetpos: 'BYSETPOS', byweekno: 'BYWEEKNO', byyearday: 'BYYEARDAY', byhour: 'BYHOUR', byminute: 'BYMINUTE', bysecond: 'BYSECOND', byeaster: 'BYEASTER',
};
/** The most days any month can have, February counted as a leap year: the test for a day that never comes. */
const MONTH_MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DAY_MS = 86_400_000;

type Freq = 'YEARLY' | 'MONTHLY' | 'WEEKLY' | 'DAILY';

interface CalendarRule {
  freq: Freq;
  interval: number;
  count: number | null;
  until: Date | null;
  bymonth: number[];
  bymonthday: number[];
  /** Weekdays 0 (Monday) to 6 (Sunday), matched on their own. */
  byweekday: number[];
  /** Weekdays with a position: the nth (or nth from the end) of the month, or of the year for YEARLY without BYMONTH. */
  bynweekday: { weekday: number; n: number }[];
  wkst: number;
}

const list = (value: unknown): unknown[] => value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];

function integers(value: unknown, name: string, min: number, max: number, nonzero = false): number[] {
  return list(value).map((v) => {
    const n = typeof v === 'number' ? v : Number.NaN;
    if (!Number.isInteger(n) || n < min || n > max || (nonzero && n === 0)) throw new Error(`${name} must be a whole number from ${min} to ${max}${nonzero ? ', not 0' : ''}`);
    return n;
  });
}

const weekdayOf = (value: unknown): { weekday: number; n: number } => {
  if (typeof value === 'number') return { weekday: value, n: 0 };
  const w = value as { weekday: number; n?: number };
  return { weekday: w.weekday, n: w.n ?? 0 };
};

/** Parses and checks the rule. Every rule that comes out of here is one the walk can settle. */
function buildRule(ruleStr: string, dtstart: Date, original: string): CalendarRule {
  if (!ruleStr.trim()) throw new Error(`invalid recurrence rule '${original}': rule is empty`);
  if (ruleStr.length > MAX_RULE_LENGTH) throw new Error(`invalid recurrence rule: must be ${MAX_RULE_LENGTH} characters or fewer`);
  try {
    const options = RRule.parseString(ruleStr) as Record<string, unknown>;
    if (options.freq === undefined) throw new Error("rule must include FREQ (e.g. 'FREQ=WEEKLY')");
    const freq = FREQ_NAMES.get(options.freq as number);
    if (!freq) throw new Error('FREQ must be DAILY, WEEKLY, MONTHLY, or YEARLY');
    for (const part of UNSUPPORTED_PARTS) {
      if (list(options[part]).length) throw new Error(`${UNSUPPORTED_NAMES[part]} is not supported`);
    }
    const [interval = 1] = integers(options.interval, 'INTERVAL', 1, MAX_INTERVAL[freq]);
    const [count = null] = integers(options.count, 'COUNT', 1, Number.MAX_SAFE_INTEGER);
    const until = options.until instanceof Date ? options.until : null;
    if (options.until !== undefined && !until) throw new Error('UNTIL must be a date');
    const bymonth = integers(options.bymonth, 'BYMONTH', 1, 12);
    const bymonthday = integers(options.bymonthday, 'BYMONTHDAY', -31, 31, true);
    if (bymonth.length && bymonthday.length && !bymonth.some((m) => bymonthday.some((d) => Math.abs(d) <= MONTH_MAX_DAYS[m - 1]))) {
      throw new Error('no month in BYMONTH has a day in BYMONTHDAY, so the rule would never come up');
    }
    const byweekday: number[] = [];
    const bynweekday: { weekday: number; n: number }[] = [];
    for (const raw of list(options.byweekday)) {
      const { weekday, n } = weekdayOf(raw);
      // A position on a weekday means nothing within a week or a day; rrule ignores it there too.
      if (n === 0 || freq === 'WEEKLY' || freq === 'DAILY') byweekday.push(weekday);
      else bynweekday.push({ weekday, n });
    }
    if (bynweekday.length) {
      if (bymonthday.length) throw new Error('BYDAY with a position (such as 2MO) cannot be combined with BYMONTHDAY');
      const limit = freq === 'MONTHLY' || bymonth.length ? 5 : 53;
      for (const { n } of bynweekday) {
        if (Math.abs(n) > limit) throw new Error(`a BYDAY position must be between -${limit} and ${limit} here`);
      }
    }
    // rrule's defaults when no day part is given: the weekday, day, or month and day of DTSTART.
    if (!bymonthday.length && !byweekday.length && !bynweekday.length) {
      if (freq === 'YEARLY') {
        if (!bymonth.length) bymonth.push(dtstart.getUTCMonth() + 1);
        bymonthday.push(dtstart.getUTCDate());
      } else if (freq === 'MONTHLY') {
        bymonthday.push(dtstart.getUTCDate());
      } else if (freq === 'WEEKLY') {
        byweekday.push(mondayFirst(dtstart));
      }
    }
    const wkst = options.wkst === undefined ? 0 : weekdayOf(options.wkst).weekday;
    return { freq, interval, count, until, bymonth, bymonthday, byweekday, bynweekday, wkst };
  } catch (e) {
    throw new Error(`invalid recurrence rule '${original}': ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Weekday with Monday as 0, the way RRULE and rrule count. */
const mondayFirst = (d: Date): number => (d.getUTCDay() + 6) % 7;
const daysInMonth = (year: number, month0: number): number => new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
const isLeap = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
const dayOfYear = (d: Date): number => Math.round((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY_MS) + 1;
/** Midnight of the first day of the week `d` is in, weeks starting on `wkst`. */
const weekStart = (d: Date, wkst: number): number => d.getTime() - ((mondayFirst(d) - wkst + 7) % 7) * DAY_MS;

/** Whether `d` is in a period the interval selects, counted from `dtstart`. */
function onInterval(rule: CalendarRule, dtstart: Date, d: Date): boolean {
  if (rule.interval === 1) return true;
  switch (rule.freq) {
    case 'DAILY': return Math.round((d.getTime() - dtstart.getTime()) / DAY_MS) % rule.interval === 0;
    case 'WEEKLY': return Math.round((weekStart(d, rule.wkst) - weekStart(dtstart, rule.wkst)) / (7 * DAY_MS)) % rule.interval === 0;
    case 'MONTHLY': return ((d.getUTCFullYear() - dtstart.getUTCFullYear()) * 12 + d.getUTCMonth() - dtstart.getUTCMonth()) % rule.interval === 0;
    case 'YEARLY': return (d.getUTCFullYear() - dtstart.getUTCFullYear()) % rule.interval === 0;
  }
}

/** Whether `d` passes every BY part, each a set the day must be in, as rrule filters its day sets. */
function passesFilters(rule: CalendarRule, d: Date): boolean {
  const year = d.getUTCFullYear();
  const month0 = d.getUTCMonth();
  const day = d.getUTCDate();
  if (rule.bymonth.length && !rule.bymonth.includes(month0 + 1)) return false;
  if (rule.bymonthday.length) {
    const fromEnd = day - daysInMonth(year, month0) - 1;
    if (!rule.bymonthday.includes(day) && !rule.bymonthday.includes(fromEnd)) return false;
  }
  const weekday = mondayFirst(d);
  if (rule.byweekday.length && !rule.byweekday.includes(weekday)) return false;
  if (rule.bynweekday.length) {
    const withinMonth = rule.freq === 'MONTHLY' || rule.bymonth.length > 0;
    const position = withinMonth ? Math.ceil(day / 7) : Math.ceil(dayOfYear(d) / 7);
    const total = withinMonth ? daysInMonth(year, month0) : (isLeap(year) ? 366 : 365);
    const fromEnd = -Math.ceil((total - (withinMonth ? day : dayOfYear(d)) + 1) / 7);
    if (!rule.bynweekday.some((w) => w.weekday === weekday && (w.n === position || w.n === fromEnd))) return false;
  }
  return true;
}

/**
 * The first occurrence at or after `notBefore` (strictly after, when `notBefore` is `dtstart`
 * and `inclusive` is false), or null when COUNT or UNTIL is exhausted first or nothing comes
 * up within the horizon. Occurrences are counted from `dtstart` inclusive, as rrule counts them.
 */
function firstOccurrence(rule: CalendarRule, dtstart: Date, notBefore: Date, inclusive: boolean): Date | null {
  let seen = 0;
  for (let i = 0; i <= HORIZON_DAYS; i++) {
    const d = new Date(dtstart.getTime() + i * DAY_MS);
    if (rule.until && d > rule.until) return null;
    if (!onInterval(rule, dtstart, d) || !passesFilters(rule, d)) continue;
    seen++;
    if (rule.count !== null && seen > rule.count) return null;
    if (inclusive ? d >= notBefore : d > notBefore) return d;
  }
  return null;
}

/**
 * Next due date for a recurring task.
 *
 * Accepts a raw RRULE ("FREQ=WEEKLY;BYDAY=MO"), the same with an "RRULE:" prefix, or a friendly
 * alias ("daily", "weekly", "weekdays", "monthly", "yearly", "every 2 weeks").
 *
 * `previousDue` is the due date of the instance that was just completed. The result is the first
 * occurrence strictly after `previousDue`, advanced (if needed) to the first occurrence on or
 * after `today` -- so a weekly task finished three weeks late spawns one instance due around now,
 * not three overdue copies. Returns null once the rule's COUNT or UNTIL is exhausted, or when
 * nothing comes up within 200 years. A date-only `previousDue` produces a date-only result; a
 * datetime `previousDue` produces a datetime result with the same time-of-day and zone.
 *
 * LIMITATION (documented, not fixed here): each call re-anchors DTSTART at `previousDue` (the
 * store keeps only the latest instance, not the series' original start), so COUNT=N is
 * approximate and can produce more than N total instances over the series' life; UNTIL is exact,
 * since it is an absolute date rather than a count from DTSTART.
 */
export function nextOccurrence(rrule: string, previousDue: string, today: string): string | null {
  const { datePart, timePart, zonePart } = splitDue(previousDue);
  const ruleStr = resolveAlias(rrule);
  const dtstart = new Date(`${datePart}T00:00:00Z`);
  const rule = buildRule(ruleStr, dtstart, rrule);

  // COUNT=1 (or any exhausted COUNT/UNTIL) means there is nothing after DTSTART: null below.
  let occurrence = firstOccurrence(rule, dtstart, dtstart, false);
  if (occurrence) {
    const todayDate = new Date(`${today}T00:00:00Z`);
    if (occurrence < todayDate) occurrence = firstOccurrence(rule, dtstart, todayDate, true);
  }
  if (!occurrence) return null;

  const dateStr = occurrence.toISOString().slice(0, 10);
  return timePart ? `${dateStr}T${timePart}${zonePart}` : dateStr;
}
