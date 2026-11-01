// Property tests for the request schemas (http/schemas.ts). Every REST body passes through one of
// them, so each must answer any value with a result and never throw: a throw would be a 500 for
// input that should be a 400.
//
// The harness is in dev/property.ts. Replay a failure with the seed and path it prints:
//   CC_PROPERTY_SEED=<seed> CC_PROPERTY_PATH=<path> node --test src/http/schemas.property.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { check } from '../dev/property.ts';
import * as schemas from './schemas.ts';

type Parser = { safeParse: (value: unknown) => { success: boolean } };
const parsers = (Object.entries(schemas) as [string, unknown][]).filter((e): e is [string, Parser] => typeof (e[1] as Partial<Parser> | null)?.safeParse === 'function');

test('property: there are schemas to check', () => {
  assert.ok(parsers.length >= 10, `found ${parsers.length}`);
});

for (const [name, schema] of parsers) {
  test(`property: ${name} answers any JSON value with a result`, () => {
    check(fc.jsonValue(), (v) => { assert.equal(typeof schema.safeParse(v).success, 'boolean'); });
  });
  test(`property: ${name} answers any value at all with a result`, () => {
    check(fc.anything(), (v) => { assert.equal(typeof schema.safeParse(v).success, 'boolean'); });
  });
}
