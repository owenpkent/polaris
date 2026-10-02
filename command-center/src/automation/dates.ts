// Small date-string helpers shared across the automation modules. Dates in this package are
// UTC calendar dates ('YYYY-MM-DD'); we never care about local time-of-day for view/rule math.

/** Add (or subtract) whole days to a 'YYYY-MM-DD' date string. */
export function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
