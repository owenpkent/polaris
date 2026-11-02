// Property tests for the X.509 tag signature verifier (update/cms.ts). A tag is third-party bytes
// until it has verified, so the verifier must answer any input with a result and never throw, and a
// signature built the way a real signer builds one must verify, while a changed payload or a
// changed signature value must not.
//
// The harness is in dev/property.ts. Replay a failure with the seed and path it prints:
//   CC_PROPERTY_SEED=<seed> CC_PROPERTY_PATH=<path> node --test src/update/cms.property.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { check, anyText } from '../dev/property.ts';
import { attribute, OIDS, octetString, signedData, signedMessageBlock, utcTime } from '../dev/der.ts';
import { SIGNED_MESSAGE_BEGIN, splitSignedTag, verifySignedMessage, type PinnedPublicKey } from './cms.ts';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const fixtureKey = createPublicKey(readFileSync(new URL('./fixtures/x509-signer.pem', import.meta.url)));
const pinned: PinnedPublicKey[] = [{ name: 'owner', key: publicKey }, { name: 'fixture', key: fixtureKey }];
const onlyOwner: PinnedPublicKey[] = [{ name: 'owner', key: publicKey }];

const bytes = fc.uint8Array({ maxLength: 300 }).map((a) => Buffer.from(a));

const hashes = ['sha256', 'sha384', 'sha512'] as const;
const extraOids = [OIDS.signingTime, '1.2.840.113549.1.9.15', '1.2.840.113549.1.9.16.2.47', '1.3.6.1.4.1.311.2.1.11'];
const extraAttribute = fc.tuple(
  fc.constantFrom(...extraOids),
  fc.oneof(
    fc.constantFrom('261101120000Z', '991231235959Z').map((t) => utcTime(t)),
    fc.uint8Array({ maxLength: 20 }).map((a) => octetString(Buffer.from(a))),
  ),
).map(([type, value]) => attribute(type, value));

const signingChoice = fc.record({
  payload: bytes,
  hash: fc.constantFrom(...hashes),
  withHashName: fc.boolean(),
  extras: fc.array(extraAttribute, { maxLength: 3 }),
});

function build(c: { payload: Buffer; hash: (typeof hashes)[number]; withHashName: boolean; extras: Buffer[] }): Buffer {
  const withRsa = { sha256: OIDS.sha256WithRsa, sha384: OIDS.sha384WithRsa, sha512: OIDS.sha512WithRsa }[c.hash];
  return signedData(c.payload, privateKey, {
    hash: c.hash,
    signatureAlgorithm: c.withHashName ? withRsa : OIDS.rsaEncryption,
    extraAttributes: c.extras,
  });
}

/** Never throws; an ok result must name a pinned signer. */
function verifyChecked(payload: Buffer, block: string, keys: PinnedPublicKey[] = pinned): boolean {
  const result = verifySignedMessage(payload, block, keys);
  if (result.ok) assert.ok(keys.some((k) => k.name === result.signer), `ok names ${result.signer}`);
  return result.ok;
}

test('property: arbitrary payload and signature block text is never accepted and never throws', () => {
  check(fc.tuple(bytes, anyText()), ([payload, block]) => {
    assert.equal(verifyChecked(payload, block), false);
  });
});

test('property: block text shaped like a signature block is never accepted and never throws', () => {
  const body = fc.string({ unit: fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/= \n'), maxLength: 300 });
  check(fc.tuple(bytes, body), ([payload, text]) => {
    assert.equal(verifyChecked(payload, `${SIGNED_MESSAGE_BEGIN}\n${text}\n-----END SIGNED MESSAGE-----\n`), false);
  });
});

test('property: a signature built by a signer verifies with the matching pinned key', () => {
  check(signingChoice, (c) => {
    const result = verifySignedMessage(c.payload, signedMessageBlock(build(c)), pinned);
    assert.deepEqual(result, { ok: true, signer: 'owner', hash: c.hash });
  });
});

test('property: one changed payload byte fails with the digest reason', () => {
  check(fc.tuple(signingChoice, fc.nat(), fc.integer({ min: 1, max: 255 })), ([c, at, delta]) => {
    const payload = c.payload.length > 0 ? c.payload : Buffer.from([0]);
    const block = signedMessageBlock(build({ ...c, payload }));
    const changed = Buffer.from(payload);
    changed[at % changed.length] ^= delta;
    const result = verifySignedMessage(changed, block, pinned);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /digest does not match/);
  });
});

test('property: one changed byte of the signature value fails', () => {
  check(fc.tuple(signingChoice, fc.integer({ min: 0, max: 255 }), fc.integer({ min: 1, max: 255 })), ([c, at, delta]) => {
    const der = build(c);
    der[der.length - 256 + at] ^= delta;
    assert.equal(verifyChecked(c.payload, signedMessageBlock(der), onlyOwner), false);
  });
});

test('property: a flipped byte or a truncation anywhere in a valid signature never throws', () => {
  check(fc.tuple(signingChoice, fc.nat(), fc.integer({ min: 1, max: 255 }), fc.nat()), ([c, at, delta, cut]) => {
    const der = build(c);
    const flipped = Buffer.from(der);
    flipped[at % flipped.length] ^= delta;
    verifyChecked(c.payload, signedMessageBlock(flipped));
    verifyChecked(c.payload, signedMessageBlock(der.subarray(0, cut % der.length)));
  });
});

test('property: splitSignedTag never throws and its two parts rebuild the tag', () => {
  const tagish = fc.tuple(bytes, fc.boolean(), bytes).map(([head, withBlock, tail]) => (
    withBlock ? Buffer.concat([head, Buffer.from('\n'), Buffer.from(SIGNED_MESSAGE_BEGIN), tail]) : head
  ));
  check(fc.oneof(bytes, tagish), (raw) => {
    const split = splitSignedTag(raw);
    if (split === null) return;
    assert.ok(split.signatureBlock.startsWith(SIGNED_MESSAGE_BEGIN));
    assert.ok(Buffer.concat([split.payload, Buffer.from(split.signatureBlock, 'latin1')]).equals(raw));
  });
});
