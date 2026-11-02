// The X.509 tag signature verifier (cms.ts). The fixture is a real tag the owner signed with the
// OK Studio EV certificate on the SafeNet eToken (through .NET SignedCms, which smimesign and
// OpenSSL agree on), and the key file is that certificate's public key: the pin a release install
// will hold. Everything else is built by dev/der.ts with a throwaway key, so every shape the
// verifier must refuse is a real CMS structure, not a string that merely looks wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeSignedMessageBlock, encodeLength, MAX_SIGNATURE_BYTES, publicKeyFingerprint, splitSignedTag, verifySignedMessage, type PinnedPublicKey } from './cms.ts';
import { attribute, octetString, OIDS, oid, setOf, signedData, signedMessageBlock, tagObject, utcTime } from '../dev/der.ts';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const etokenTag = readFileSync(join(fixtures, 'x509-tag.txt'));
const etokenKey = createPublicKey(readFileSync(join(fixtures, 'x509-signer.pem')));
const etoken: PinnedPublicKey = { name: 'ok-studio-ev', key: etokenKey };

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ours: PinnedPublicKey = { name: 'test-key', key: publicKey };
const payload = tagObject('v2.3.0', 'Release 2.3.0\n\nNotes.');
const sign = (p: Buffer, options = {}, key: KeyObject = privateKey) => signedMessageBlock(signedData(p, key, options));

test('the tag the eToken signed verifies against its pinned public key, and the fixture is the git object', () => {
  const split = splitSignedTag(etokenTag);
  assert.ok(split);
  assert.equal(split.payload.toString('utf8').split('\n')[2], 'tag v0.0.1-dryrun');
  assert.deepEqual(verifySignedMessage(split.payload, split.signatureBlock, [etoken]), { ok: true, signer: 'ok-studio-ev', hash: 'sha256' });
  assert.equal(publicKeyFingerprint(etokenKey), 'SHA256:h674z/rpVCxy8YPeMpzdGYxlQs4jthEZJu5qzbQ7DGo');
  const git = spawnSync('git', ['hash-object', '-t', 'tag', '--stdin'], { input: etokenTag, encoding: 'utf8' });
  if (!git.error) assert.equal(git.stdout.trim(), '068bf7faa908997b50a3cf496d6bd842249191b0', 'the fixture is byte for byte the tag object git stored');
});

test('a tag changed after the eToken signed it does not verify, whichever byte changed', () => {
  const { payload: signed, signatureBlock } = splitSignedTag(etokenTag)!;
  for (const at of [0, 7, 60, signed.length - 2, signed.length - 1]) {
    const changed = Buffer.from(signed);
    changed[at] ^= 0x01;
    const r = verifySignedMessage(changed, signatureBlock, [etoken]);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /changed after it was signed/);
  }
  const grown = Buffer.concat([signed, Buffer.from('\n')]);
  assert.equal(verifySignedMessage(grown, signatureBlock, [etoken]).ok, false);
});

test('only a pinned RSA key counts: another key, an Ed25519 key, or no key is "no pinned key signed it"', () => {
  const { payload: signed, signatureBlock } = splitSignedTag(etokenTag)!;
  const ed = generateKeyPairSync('ed25519').publicKey;
  assert.deepEqual(verifySignedMessage(signed, signatureBlock, [{ name: 'other', key: other.publicKey }, { name: 'ed', key: ed }]), { ok: false, reason: 'no pinned key signed it' });
  assert.deepEqual(verifySignedMessage(signed, signatureBlock, []), { ok: false, reason: 'no pinned key signed it' });
  // The order of the pins does not matter, and the matching one is named.
  assert.deepEqual(verifySignedMessage(signed, signatureBlock, [{ name: 'ed', key: ed }, { name: 'other', key: other.publicKey }, etoken]), { ok: true, signer: 'ok-studio-ev', hash: 'sha256' });
});

test('a signature built the way a signer builds one verifies: each SHA-2 digest, either RSA OID, extra signed attributes, embedded certificates', () => {
  assert.deepEqual(verifySignedMessage(payload, sign(payload), [ours]), { ok: true, signer: 'test-key', hash: 'sha256' });
  assert.deepEqual(verifySignedMessage(payload, sign(payload, { hash: 'sha384', signatureAlgorithm: OIDS.sha384WithRsa }), [ours]), { ok: true, signer: 'test-key', hash: 'sha384' });
  assert.deepEqual(verifySignedMessage(payload, sign(payload, { hash: 'sha512' }), [ours]), { ok: true, signer: 'test-key', hash: 'sha512' });
  assert.equal(verifySignedMessage(payload, sign(payload, { signatureAlgorithm: OIDS.sha256WithRsa }), [ours]).ok, true);
  const extras = [attribute(OIDS.signingTime, utcTime('261102192610Z')), attribute('1.2.840.113549.1.9.15', setOf(oid(OIDS.sha256)))];
  assert.equal(verifySignedMessage(payload, sign(payload, { extraAttributes: extras }), [ours]).ok, true);
  // Whatever sits in the certificates slot is skipped unread: the pin is the key.
  const certificates = Buffer.concat([Buffer.from([0xa0]), encodeLength(3), Buffer.from([0x30, 0x01, 0x00])]);
  assert.equal(verifySignedMessage(payload, sign(payload, { certificates }), [ours]).ok, true);
  assert.deepEqual(verifySignedMessage(payload, sign(payload), [{ name: 'other', key: other.publicKey }]), { ok: false, reason: 'no pinned key signed it' });
});

test('the shapes a release signature never has are refused, each with its reason', () => {
  const refused = (block: string, reason: RegExp, p = payload) => {
    const r = verifySignedMessage(p, block, [ours]);
    assert.equal(r.ok, false, `verified: ${block.slice(0, 80)}`);
    assert.match((r as { reason: string }).reason, reason);
  };
  refused(sign(payload, { withoutSignedAttributes: true }), /no signed attributes/);
  refused(sign(payload, { signerCount: 2 }), /2 signers; a release signature has one/);
  refused(sign(payload, { signerCount: 0 }), /0 signers/);
  refused(sign(payload, { embedContent: true }), /carries its own content/);
  refused(sign(payload, { hash: 'sha1' as 'sha256' }), /not SHA-256, SHA-384, or SHA-512/);
  refused(sign(payload, { signatureAlgorithm: OIDS.rsaPss }), /not RSA PKCS#1 v1\.5 with sha256/);
  refused(sign(payload, { signatureAlgorithm: OIDS.sha512WithRsa }), /not RSA PKCS#1 v1\.5 with sha256/, payload);
  refused(sign(payload, { hash: 'sha384', signatureAlgorithm: OIDS.sha256WithRsa }), /not RSA PKCS#1 v1\.5 with sha384/);
  refused(sign(payload, { trailing: Buffer.from([0x00]) }), /bytes after its end/);
  refused(sign(payload, { messageDigest: Buffer.alloc(32) }), /changed after it was signed/);
  refused(sign(payload, { messageDigest: Buffer.alloc(48) }), /wrong length/);
  refused(sign(payload, { contentTypeValue: OIDS.signedData }), /content type attribute is not id-data/);
  // A signature over a different payload is a digest mismatch, before any key is tried.
  refused(sign(tagObject('v2.3.0', 'Other notes')), /changed after it was signed/);
  // The right digest but a signature made by a key that is not pinned.
  refused(sign(payload, {}, other.privateKey), /no pinned key signed it/);
});

test('the signed attributes must name the content type once and carry one message digest', () => {
  const der = signedData(payload, privateKey, { extraAttributes: [attribute(OIDS.contentType, oid(OIDS.data))] });
  const r = verifySignedMessage(payload, signedMessageBlock(der), [ours]);
  assert.deepEqual(r, { ok: false, reason: 'the signed attributes do not name the content type once' });
  const twoDigests = signedData(payload, privateKey, { extraAttributes: [attribute(OIDS.messageDigest, octetString(Buffer.alloc(32)))] });
  assert.deepEqual(verifySignedMessage(payload, signedMessageBlock(twoDigests), [ours]), { ok: false, reason: 'the message digest attribute is not one value' });
});

test('the PEM block: CRLF and a trailing newline are fine; a missing line, stray text, or an oversized body is refused', () => {
  const block = sign(payload);
  assert.equal(verifySignedMessage(payload, block.replace(/\n/g, '\r\n'), [ours]).ok, true);
  assert.equal(verifySignedMessage(payload, `${block}\n\n`, [ours]).ok, true);
  assert.equal(verifySignedMessage(payload, block.trimEnd(), [ours]).ok, true);
  const reasonOf = (b: string) => (verifySignedMessage(payload, b, [ours]) as { reason: string }).reason;
  assert.match(reasonOf(block.replace('-----BEGIN SIGNED MESSAGE-----\n', '')), /does not open with/);
  assert.match(reasonOf(block.replace('-----END SIGNED MESSAGE-----', '')), /does not close with/);
  assert.match(reasonOf(block.replace('-----END SIGNED MESSAGE-----', '-----END PGP SIGNATURE-----')), /does not close with/);
  assert.match(reasonOf(`${block}trailing text\n`), /does not close with/);
  assert.match(reasonOf(block.replace(/\n[^-][^\n]*\n/, '\n*bad*\n')), /not base64/);
  assert.match(reasonOf('-----BEGIN SIGNED MESSAGE-----\n-----END SIGNED MESSAGE-----\n'), /not base64/);
  const huge = `-----BEGIN SIGNED MESSAGE-----\n${Buffer.alloc(MAX_SIGNATURE_BYTES + 1).toString('base64')}\n-----END SIGNED MESSAGE-----\n`;
  assert.match(reasonOf(huge), /the most a release signature can be/);
  assert.throws(() => decodeSignedMessageBlock('nothing'), /does not open with/);
});

test('the DER reader is strict: indefinite, non-minimal, or truncated lengths, multi-byte tags, and the wrong outer type', () => {
  const der = signedData(payload, privateKey);
  const reasonOf = (bytes: Buffer) => (verifySignedMessage(payload, signedMessageBlock(bytes), [ours]) as { reason: string }).reason;
  // The outer SEQUENCE has a two-byte length (0x82 hi lo) for a signature this size.
  assert.equal(der[1], 0x82);
  const indefinite = Buffer.from(der); indefinite[1] = 0x80;
  assert.match(reasonOf(indefinite), /indefinite length/);
  const leadingZero = Buffer.concat([Buffer.from([0x30, 0x83, 0x00]), der.subarray(2)]);
  assert.match(reasonOf(leadingZero), /leading zero/);
  const longForm = Buffer.concat([Buffer.from([0x30, 0x81, 0x05]), Buffer.alloc(5)]);
  assert.match(reasonOf(longForm), /shortest form/);
  assert.match(reasonOf(der.subarray(0, der.length - 10)), /truncated/);
  assert.match(reasonOf(Buffer.from([0x30, 0x00])), /not a ContentInfo/);
  assert.match(reasonOf(Buffer.from([0x30, 0x02, 0x1f, 0x00])), /multi-byte tag/);
  assert.match(reasonOf(Buffer.from([0x04, 0x00])), /expected tag 0x30, found 0x4/);
  const notSignedData = Buffer.from(der);
  notSignedData[4 + 8] ^= 0x01; // the last byte of the signedData OID
  assert.match(reasonOf(notSignedData), /not CMS SignedData/);
  assert.match(reasonOf(Buffer.alloc(0)), /not base64/);
  assert.match(reasonOf(Buffer.from([0x30])), /truncated/);
});

test('splitSignedTag finds the block at a line start and keeps every byte', () => {
  assert.equal(splitSignedTag(tagObject('v1.0.0', 'unsigned')), null);
  const block = sign(payload);
  const whole = Buffer.concat([payload, Buffer.from(block)]);
  const split = splitSignedTag(whole)!;
  assert.deepEqual(split.payload, payload);
  assert.equal(split.signatureBlock, block);
  // A BEGIN line quoted mid-line in the message is not where the signature starts.
  const quoting = tagObject('v1.0.0', 'the message says -----BEGIN SIGNED MESSAGE----- in passing');
  assert.equal(splitSignedTag(quoting), null);
  const quotingThenSigned = Buffer.concat([quoting, Buffer.from(sign(quoting))]);
  assert.deepEqual(splitSignedTag(quotingThenSigned)!.payload, quoting);
  assert.equal(verifySignedMessage(quoting, splitSignedTag(quotingThenSigned)!.signatureBlock, [ours]).ok, true);
  // A block with no preceding newline at the very start of the data is a block over an empty payload.
  assert.equal(splitSignedTag(Buffer.from(block))!.payload.length, 0);
});

test('the OID table in cms.ts and the encoder in der.ts agree', () => {
  const expected: Record<string, string> = {
    [OIDS.signedData]: '2a864886f70d010702', [OIDS.data]: '2a864886f70d010701', [OIDS.contentType]: '2a864886f70d010903',
    [OIDS.messageDigest]: '2a864886f70d010904', [OIDS.sha256]: '608648016503040201', [OIDS.sha384]: '608648016503040202',
    [OIDS.sha512]: '608648016503040203', [OIDS.rsaEncryption]: '2a864886f70d010101', [OIDS.sha256WithRsa]: '2a864886f70d01010b',
    [OIDS.sha384WithRsa]: '2a864886f70d01010c', [OIDS.sha512WithRsa]: '2a864886f70d01010d',
  };
  for (const [dotted, hex] of Object.entries(expected)) assert.equal(oid(dotted).subarray(2).toString('hex'), hex, dotted);
  assert.deepEqual([...encodeLength(0x7f)], [0x7f]);
  assert.deepEqual([...encodeLength(0x80)], [0x81, 0x80]);
  assert.deepEqual([...encodeLength(0x100)], [0x82, 0x01, 0x00]);
});
