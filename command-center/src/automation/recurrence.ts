// Recurrence: turn an RRULE (or a friendly alias) plus the due date of the last instance into
// the due date of the next instance.
//
// rrule ships as a CJS/UMD bundle with no package.json "exports" map, so under Node's ESM
// loader only a default export is visible (named exports are not statically detectable). We
// pull RRule off the default import rather than `import { RRule } from 'rrule'`.
import rrulePkg from 'rrule';
import { withOneFewer } from '../core/recurrenceCount.ts';

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

/** Whether a part's name or value has spaces at either end. rrule refuses some and keeps others. */
const spaced = (key: string, value: string): boolean => key !== key.trim() || value !== value.trim();

/**
 * The one extension part a rule may carry, `X-FROM=COMPLETION`: the next due date counts from the
 * day the task is finished rather than from its due date. It is taken off before the rest goes to
 * rrule, which knows nothing of it. Any other `X-` part is refused by name, as is a second X-FROM.
 */
function splitExtensions(input: string): { base: string; fromCompletion: boolean } {
  const kept: string[] = [];
  let fromCompletion = false;
  for (const piece of input.trim().split(';')) {
    const [rawKey, ...rest] = piece.split('=');
    const key = rawKey.trim().replace(/^RRULE:/i, '').toUpperCase();
    // Checked here, before the alias step trims the rest: taking X-FROM off could leave "COUNT=2 "
    // as the end of the rule, which rrule reads as 2 and the store would not.
    if (rest.length && spaced(rawKey.replace(/^RRULE:/i, ''), rest.join('='))) throw new Error(`spaces are not allowed around ${key} or its value`);
    if (!key.startsWith('X-')) { kept.push(piece); continue; }
    const value = rest.join('=').toUpperCase();
    if (key !== 'X-FROM') throw new Error(`${key} is not supported (the only extension is X-FROM=COMPLETION)`);
    if (value !== 'COMPLETION') throw new Error("X-FROM must be COMPLETION (leave it out to count from the due date)");
    if (fromCompletion) throw new Error('X-FROM is given twice');
    fromCompletion = true;
  }
  // A leading "RRULE:" on an X- part that came first is dropped with it; put it back for the rest.
  const base = kept.join(';');
  return { base: /^RRULE:/i.test(input.trim()) && !/^RRULE:/i.test(base) ? `RRULE:${base}` : base, fromCompletion };
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
// is accepted, the walk agrees with rrule, with one deliberate difference: COUNT counts the tasks
// left rather than dates from DTSTART (see nextOccurrence). recurrence.test.ts checks the walk
// against rrule itself. The extension X-FROM=COMPLETION is taken off before rrule sees the rule.

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
/**
 * What rrule lets through but a task rule must not have. rrule keeps the last of a part given
 * twice, reads COUNT=+2 as 2, and reads "COUNT=2 " as 2, while the store, which rewrites COUNT as the series goes
 * (core/recurrenceCount.ts), reads exactly one COUNT written in digits. Refusing both here keeps
 * the two readings the same for every rule that is saved.
 */
function checkParts(ruleStr: string): void {
  const seen = new Set<string>();
  for (const piece of ruleStr.split(';')) {
    const [rawKey, ...rest] = piece.split('=');
    const bare = rawKey.replace(/^RRULE:/i, '');
    const key = bare.trim().toUpperCase();
    // Taking X-FROM off can leave "COUNT=2 " behind, which rrule reads as 2 and the store would not.
    if (spaced(bare, rest.join('='))) throw new Error(`spaces are not allowed around ${key} or its value`);
    if (seen.has(key)) throw new Error(`${key} is given twice`);
    seen.add(key);
    // A leading + is the one sign rrule reads as a number; anything else wrong is caught below.
    if ((key === 'COUNT' || key === 'INTERVAL') && /^\s*\+/.test(rest.join('='))) {
      throw new Error(`${key} must be written as digits only, such as ${key}=5`);
    }
  }
}

function buildRule(ruleStr: string, dtstart: Date, original: string, fromCompletion = false): CalendarRule {
  if (!ruleStr.trim()) throw new Error(`invalid recurrence rule '${original}': rule is empty`);
  if (ruleStr.length > MAX_RULE_LENGTH) throw new Error(`invalid recurrence rule: must be ${MAX_RULE_LENGTH} characters or fewer`);
  try {
    checkParts(ruleStr);
    const options = RRule.parseString(ruleStr) as Record<string, unknown>;
    if (options.freq === undefined) throw new Error("rule must include FREQ (e.g. 'FREQ=WEEKLY')");
    const freq = FREQ_NAMES.get(options.freq as number);
    if (!freq) throw new Error('FREQ must be DAILY, WEEKLY, MONTHLY, or YEARLY');
    for (const part of UNSUPPORTED_PARTS) {
      if (list(options[part]).length) throw new Error(`${UNSUPPORTED_NAMES[part]} is not supported`);
    }
    // Counted from the finish, the next date is a span after that day (see fromFinish), and a day
    // part would fight it: a weekly Monday rule finished early on a Saturday would come back on
    // the Monday it was due.
    if (fromCompletion && (list(options.byweekday).length || list(options.bymonthday).length || list(options.bymonth).length)) {
      throw new Error('X-FROM=COMPLETION cannot be combined with BYDAY, BYMONTHDAY, or BYMONTH: the next one is counted from the day the task is finished, so leave the days out');
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
 * and `inclusive` is false), or null when UNTIL is passed first or nothing comes up within the
 * horizon. COUNT plays no part here: it counts tasks, not dates (see nextOccurrence).
 */
function firstOccurrence(rule: CalendarRule, dtstart: Date, notBefore: Date, inclusive: boolean): Date | null {
  for (let i = 0; i <= HORIZON_DAYS; i++) {
    const d = new Date(dtstart.getTime() + i * DAY_MS);
    if (rule.until && d > rule.until) return null;
    if (!onInterval(rule, dtstart, d) || !passesFilters(rule, d)) continue;
    if (inclusive ? d >= notBefore : d > notBefore) return d;
  }
  return null;
}

/** `steps` periods of the rule's frequency after `anchor`, a month or a year held to the target month's last day. */
function addPeriods(anchor: Date, freq: Freq, steps: number): Date {
  if (freq === 'DAILY') return new Date(anchor.getTime() + steps * DAY_MS);
  if (freq === 'WEEKLY') return new Date(anchor.getTime() + steps * 7 * DAY_MS);
  const months = freq === 'MONTHLY' ? steps : steps * 12;
  const year = anchor.getUTCFullYear() + Math.floor((anchor.getUTCMonth() + months) / 12);
  const month0 = (anchor.getUTCMonth() + months) % 12;
  return new Date(Date.UTC(year, month0, Math.min(anchor.getUTCDate(), daysInMonth(year, month0))));
}

/**
 * The next date of a rule counted from the finish: INTERVAL periods after `anchor`, then further
 * whole spans from the same anchor until it is on or after `today` (only a skip of a long-overdue
 * task gets that far), or null past UNTIL or the horizon.
 */
function fromFinish(rule: CalendarRule, anchor: Date, today: Date): Date | null {
  // An invalid date compares false both ways, so the loop is also bounded by the horizon's own
  // step count: nothing here may run forever on a request.
  if (Number.isNaN(anchor.getTime()) || Number.isNaN(today.getTime())) return null;
  const horizon = anchor.getTime() + HORIZON_DAYS * DAY_MS;
  for (let k = 1; k <= HORIZON_DAYS; k++) {
    const d = addPeriods(anchor, rule.freq, k * rule.interval);
    if (Number.isNaN(d.getTime()) || d.getTime() > horizon || (rule.until && d > rule.until)) return null;
    if (d >= today) return d;
  }
  return null;
}

/** What the store knows about why the next date is wanted. Only completeTask passes it. */
export interface OccurrenceContext {
  /** The day (YYYY-MM-DD) the task was finished on, for a rule with X-FROM=COMPLETION. */
  completedOn?: string;
}

/**
 * Next due date for a recurring task.
 *
 * Accepts a raw RRULE ("FREQ=WEEKLY;BYDAY=MO"), the same with an "RRULE:" prefix, or a friendly
 * alias ("daily", "weekly", "weekdays", "monthly", "yearly", "every 2 weeks"), either of them
 * optionally followed by ";X-FROM=COMPLETION".
 *
 * `previousDue` is the due date of the instance that was just completed. The result is the first
 * occurrence strictly after `previousDue`, advanced (if needed) to the first occurrence on or
 * after `today` -- so a weekly task finished three weeks late spawns one instance due around now,
 * not three overdue copies. Returns null once the rule's COUNT or UNTIL is exhausted, or when
 * nothing comes up within 200 years. A date-only `previousDue` produces a date-only result; a
 * datetime `previousDue` produces a datetime result with the same time-of-day and zone.
 *
 * X-FROM=COMPLETION: such a rule has no day parts, and its next date is a span after an anchor:
 * INTERVAL days, weeks, months, or years after the day the task was finished, when
 * `context.completedOn` is given (the store passes it only when a task is completed), else after
 * `previousDue` (a skip, a preview, validation). A month or a year lands on the same day of the
 * target month, or on its last day when the month is shorter (Oct 31 to Nov 30, Feb 29 to Feb 28),
 * never skipping a month the way an RRULE day of the month would. The time of day is kept, and
 * UNTIL and COUNT end it as they end any rule.
 *
 * COUNT is exact, and counts tasks: COUNT=N on a task means this one and N-1 more. This function
 * only has to know whether any are left (COUNT=1 means none: null), because the store lowers
 * COUNT by one on the rule each time an occurrence is used up, on the next instance when a task is
 * completed and on the task itself when one is skipped (core/recurrenceCount.ts). A late
 * completion that jumps the walk past missed dates does not use them up: the series still gives
 * the same number of tasks. UNTIL is exact too, since it is an absolute date.
 */
export function nextOccurrence(rrule: string, previousDue: string, today: string, context: OccurrenceContext = {}): string | null {
  const { datePart, timePart, zonePart } = splitDue(previousDue);
  if (rrule.length > MAX_RULE_LENGTH) throw new Error(`invalid recurrence rule: must be ${MAX_RULE_LENGTH} characters or fewer`);
  let split: { base: string; fromCompletion: boolean };
  try {
    split = splitExtensions(rrule);
  } catch (e) {
    throw new Error(`invalid recurrence rule '${rrule}': ${e instanceof Error ? e.message : String(e)}`);
  }
  const ruleStr = resolveAlias(split.base);
  const anchor = split.fromCompletion && context.completedOn ? splitDue(context.completedOn).datePart : datePart;
  const dtstart = new Date(`${anchor}T00:00:00Z`);
  // splitDue checks the shape; a day that does not exist (a 13th month) gets this far.
  if (Number.isNaN(dtstart.getTime())) throw new Error(`invalid date '${anchor}': no such day`);
  const rule = buildRule(ruleStr, dtstart, rrule, split.fromCompletion);
  if (rule.count === 1) return null;
  const todayDate = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(todayDate.getTime())) throw new Error(`invalid date '${today}': no such day`);

  let occurrence: Date | null;
  if (split.fromCompletion) {
    occurrence = fromFinish(rule, dtstart, todayDate);
  } else {
    occurrence = firstOccurrence(rule, dtstart, dtstart, false);
    if (occurrence && occurrence < todayDate) occurrence = firstOccurrence(rule, dtstart, todayDate, true);
  }
  if (!occurrence) return null;

  const dateStr = occurrence.toISOString().slice(0, 10);
  return timePart ? `${dateStr}T${timePart}${zonePart}` : dateStr;
}

/**
 * The next `count` occurrences after `from`, each chained from the one before, the way completing
 * each one on its due date would go: COUNT is lowered at every step as the store lowers it. Stops
 * early when the series ends, so the result can be shorter than `count` or empty. Throws on an
 * invalid rule. A rule with X-FROM=COMPLETION is previewed from its due dates, as if each one were
 * finished on the day it is due.
 */
export function previewOccurrences(rrule: string, from: string, today: string, count: number): string[] {
  const dates: string[] = [];
  let cursor = from;
  let rule = rrule;
  for (let i = 0; i < count; i++) {
    const next = nextOccurrence(rule, cursor, today);
    if (!next) break;
    dates.push(next);
    cursor = next;
    rule = withOneFewer(rule);
  }
  return dates;
}
