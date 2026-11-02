// Property tests for due date handling (core/dueAt.ts): what a person types on the command line,
// how a due value is shown, and how a value with a zone becomes floating local time.
//
// The harness is in dev/property.ts. Replay a failure with the seed and path it prints:
//   CC_PROPERTY_SEED=<seed> CC_PROPERTY_PATH=<path> node --test src/core/dueAt.property.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { check, anyText } from '../dev/property.ts';
import { dueDay, formatDue, isDateOnly, parseDueInput, toLocalDue } from './dueAt.ts';

const TIMEZONES = ['UTC', 'Europe/London', 'America/New_York', 'Asia/Kolkata', 'Australia/Lord_Howe'];
const pad = (n: number): string => String(n).padStart(2, '0');
const day = fc.tuple(fc.integer({ min: 2000, max: 2099 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 }))
  .map(([y, m, d]) => `${y}-${pad(m)}-${pad(d)}`);
const hm = fc.tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }));
const zone = fc.oneof(
  fc.constant('Z'),
  fc.tuple(fc.constantFrom('+', '-'), fc.integer({ min: 0, max: 13 }), fc.constantFrom(0, 30, 45)).map(([s, h, m]) => `${s}${pad(h)}:${pad(m)}`),
);
const isoLocal = fc.tuple(day, hm, fc.option(fc.integer({ min: 0, max: 59 }), { nil: undefined }))
  .map(([d, [h, m], s]) => `${d}T${pad(h)}:${pad(m)}${s === undefined ? '' : `:${pad(s)}`}`);
const isoZoned = fc.tuple(isoLocal, zone).map(([v, z]) => `${v}${z}`);

test('property: parseDueInput returns a string or refuses with "not a time of day"', () => {
  check(anyText(), (t) => {
    try {
      assert.equal(typeof parseDueInput(t), 'string');
    } catch (e) {
      assert.ok(e instanceof Error && e.message.includes('not a time of day'), String(e));
    }
  });
});

test('property: a typed day and time becomes YYYY-MM-DDTHH:MM with a two-digit hour', () => {
  check(fc.tuple(day, fc.constantFrom(' ', 'T'), hm, fc.boolean()), ([d, sep, [h, m], padded]) => {
    const typed = `${d}${sep}${padded ? pad(h) : String(h)}:${pad(m)}`;
    assert.equal(parseDueInput(typed), `${d}T${pad(h)}:${pad(m)}`);
  });
});

test('property: formatDue is a fixed point on its own output', () => {
  check(fc.oneof(isoLocal, isoZoned), (v) => {
    assert.equal(formatDue(formatDue(v)), formatDue(v));
  });
});

test('property: formatDue leaves a value without a T alone', () => {
  check(anyText(), (v) => {
    if (!v.includes('T')) assert.equal(formatDue(v), v);
  });
});

test('property: toLocalDue never throws, whatever the text', () => {
  check(fc.tuple(anyText(), fc.constantFrom(...TIMEZONES)), ([v, tz]) => { toLocalDue(v, tz); });
});

test('property: toLocalDue is idempotent on ISO datetimes', () => {
  check(fc.tuple(fc.oneof(isoLocal, isoZoned), fc.constantFrom(...TIMEZONES)), ([v, tz]) => {
    const once = toLocalDue(v, tz);
    assert.equal(toLocalDue(once, tz), once);
  });
});

test('property: a date-only value is its own day', () => {
  check(fc.oneof(day, anyText(20)), (v) => {
    if (isDateOnly(v)) assert.equal(dueDay(v), v);
  });
});
