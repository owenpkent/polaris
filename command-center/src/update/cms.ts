// The X.509 signature on a git tag (`gpg.format x509`): a `-----BEGIN SIGNED MESSAGE-----` block
// at the end of the tag object, holding a detached CMS SignedData (RFC 5652) over everything
// before it. This verifies one against pinned public keys with node:crypto alone. There is no
// certificate chain, no trust store, and no expiry: the pin is the signer's public key, as an
// allowed_signers line pins an SSH key, so a renewed or expired certificate changes nothing until
// the owner pins the new key (docs/releases.md). The certificates a signature embeds are never read.
//
// The DER reader is strict: definite lengths only, minimal length encoding, single-byte tags, no
// bytes after a structure, a size cap and a depth cap. Anything it does not like is a reason in
// the result, never an exception; a tag is third-party bytes until it has verified.
//
// For a signature to count it must have: one SignerInfo; content type id-data with the content
// detached; signed attributes with one contentType (id-data) and one messageDigest equal to the
// SHA-2 digest of the payload; an RSA PKCS#1 v1.5 signature whose hash is that same digest, over
// the signed attributes re-tagged as SET OF; and the signing key among the pinned ones.
// Attributes it does not know (signingTime, S/MIME capabilities) are covered by the signature and
// otherwise ignored: the time a signer claims is not evidence.
import { constants, createHash, timingSafeEqual, verify, type KeyObject } from 'node:crypto';

export const SIGNED_MESSAGE_BEGIN = '-----BEGIN SIGNED MESSAGE-----';
export const SIGNED_MESSAGE_END = '-----END SIGNED MESSAGE-----';

/** The most bytes a signature block may decode to. A real one with its certificate chain is
 *  a few kilobytes; the cap bounds the work a forged tag can ask for. */
export const MAX_SIGNATURE_BYTES = 64 * 1024;
const MAX_DEPTH = 16;
const MAX_CHILDREN = 64;

export interface PinnedPublicKey {
  /** How the owner knows the key: the principal of its signers line. Reported on success. */
  name: string;
  key: KeyObject;
}

export type CmsVerification =
  | { ok: true; signer: string; hash: 'sha256' | 'sha384' | 'sha512' }
  | { ok: false; reason: string };

/** `name` is the key's principal; `key` a public KeyObject of any type: a non-RSA key never matches. */
export function verifySignedMessage(payload: Buffer, signatureBlock: string, pinned: PinnedPublicKey[]): CmsVerification {
  try {
    const der = decodeSignedMessageBlock(signatureBlock);
    const info = readSignedData(der);
    const hash = info.hash;
    const digest = createHash(hash).update(payload).digest();
    if (digest.length !== info.messageDigest.length || !timingSafeEqual(digest, info.messageDigest)) {
      return { ok: false, reason: 'the signed digest does not match the tag; the tag was changed after it was signed' };
    }
    for (const { name, key } of pinned) {
      if (key.type !== 'public' || key.asymmetricKeyType !== 'rsa') continue;
      if (rsaVerifies(hash, info.signedAttributes, key, info.signature)) return { ok: true, signer: name, hash };
    }
    return { ok: false, reason: 'no pinned key signed it' };
  } catch (err) {
    if (err instanceof CmsFormatError) return { ok: false, reason: err.message };
    throw err;
  }
}

/** The tag's payload (the bytes the signer signed) and its signature block, or null when the tag
 *  has no `-----BEGIN SIGNED MESSAGE-----` line. The block runs to the end of the object, as git
 *  reads it; what follows the END line is the block's problem (`verifySignedMessage` refuses it). */
export function splitSignedTag(rawTag: Buffer): { payload: Buffer; signatureBlock: string } | null {
  const marker = Buffer.from(SIGNED_MESSAGE_BEGIN, 'latin1');
  let at = rawTag.indexOf(marker);
  while (at > 0 && rawTag[at - 1] !== 0x0a) at = rawTag.indexOf(marker, at + 1);
  if (at < 0) return null;
  return { payload: rawTag.subarray(0, at), signatureBlock: rawTag.subarray(at).toString('latin1') };
}

/** `SHA256:` and the unpadded base64 SHA-256 of the key's SubjectPublicKeyInfo, which
 *  `openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | base64` reproduces. */
export function publicKeyFingerprint(key: KeyObject): string {
  const spki = key.export({ type: 'spki', format: 'der' });
  return `SHA256:${createHash('sha256').update(spki).digest('base64').replace(/=+$/, '')}`;
}

class CmsFormatError extends Error {}
const refuse = (reason: string): never => { throw new CmsFormatError(reason); };

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** The DER inside the PEM block. The block must open on its first line, close on its last, and
 *  carry base64 and nothing else between (whitespace aside). */
export function decodeSignedMessageBlock(block: string): Buffer {
  const lines = block.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length < 2 || lines[0].trim() !== SIGNED_MESSAGE_BEGIN) refuse('the signature block does not open with the SIGNED MESSAGE line');
  if (lines[lines.length - 1].trim() !== SIGNED_MESSAGE_END) refuse('the signature block does not close with the END SIGNED MESSAGE line');
  const body = lines.slice(1, -1).join('').replace(/\s+/g, '');
  if (body.length === 0 || body.length % 4 !== 0 || !BASE64_RE.test(body)) refuse('the signature block is not base64');
  const der = Buffer.from(body, 'base64');
  if (der.length > MAX_SIGNATURE_BYTES) refuse(`the signature is ${der.length} bytes; the most a release signature can be is ${MAX_SIGNATURE_BYTES}`);
  return der;
}

// DER reader. A Tlv is one element: its tag byte, its content (a view, not a copy), and where it
// ends in its parent. Nothing here allocates per byte.

interface Tlv { tag: number; content: Buffer; end: number }

const TAG = {
  integer: 0x02, octetString: 0x04, oid: 0x06, sequence: 0x30, set: 0x31,
  ctx0Constructed: 0xa0, ctx1Constructed: 0xa1, ctx0Primitive: 0x80,
} as const;

function readTlv(buf: Buffer, at: number, limit: number, what: string): Tlv {
  if (at + 2 > limit) refuse(`${what}: truncated`);
  const tag = buf[at];
  if ((tag & 0x1f) === 0x1f) refuse(`${what}: a multi-byte tag`);
  let length = buf[at + 1];
  let headerEnd = at + 2;
  if (length === 0x80) refuse(`${what}: indefinite length`);
  if (length > 0x80) {
    const n = length & 0x7f;
    if (n > 4) refuse(`${what}: a length over 4 bytes`);
    if (headerEnd + n > limit) refuse(`${what}: truncated`);
    if (buf[headerEnd] === 0) refuse(`${what}: a length with a leading zero`);
    length = 0;
    for (let i = 0; i < n; i++) length = length * 256 + buf[headerEnd + i];
    if (length < 0x80 || (n > 1 && length < 256 ** (n - 1))) refuse(`${what}: a length not in its shortest form`);
    headerEnd += n;
  }
  if (headerEnd + length > limit) refuse(`${what}: truncated`);
  return { tag, content: buf.subarray(headerEnd, headerEnd + length), end: headerEnd + length };
}

/** Every element inside a constructed one, exactly filling it. */
function children(tlv: Tlv, what: string, depth: number): Tlv[] {
  if (depth > MAX_DEPTH) refuse(`${what}: nested too deep`);
  const out: Tlv[] = [];
  let at = 0;
  while (at < tlv.content.length) {
    if (out.length >= MAX_CHILDREN) refuse(`${what}: too many elements`);
    const child = readTlv(tlv.content, at, tlv.content.length, what);
    out.push(child);
    at = child.end;
  }
  return out;
}

function expectTag(tlv: Tlv, tag: number, what: string): Tlv {
  if (tlv.tag !== tag) refuse(`${what}: expected tag 0x${tag.toString(16)}, found 0x${tlv.tag.toString(16)}`);
  return tlv;
}

const OID = {
  signedData: Buffer.from('2a864886f70d010702', 'hex'),
  data: Buffer.from('2a864886f70d010701', 'hex'),
  contentType: Buffer.from('2a864886f70d010903', 'hex'),
  messageDigest: Buffer.from('2a864886f70d010904', 'hex'),
  sha256: Buffer.from('608648016503040201', 'hex'),
  sha384: Buffer.from('608648016503040202', 'hex'),
  sha512: Buffer.from('608648016503040203', 'hex'),
  rsaEncryption: Buffer.from('2a864886f70d010101', 'hex'),
  sha256WithRsa: Buffer.from('2a864886f70d01010b', 'hex'),
  sha384WithRsa: Buffer.from('2a864886f70d01010c', 'hex'),
  sha512WithRsa: Buffer.from('2a864886f70d01010d', 'hex'),
};

type Hash = 'sha256' | 'sha384' | 'sha512';

/** The OID of an AlgorithmIdentifier (SEQUENCE { OID, parameters OPTIONAL }). */
function algorithmOid(tlv: Tlv, what: string, depth: number): Buffer {
  const parts = children(expectTag(tlv, TAG.sequence, what), what, depth + 1);
  if (parts.length < 1 || parts.length > 2) refuse(`${what}: not an algorithm identifier`);
  return expectTag(parts[0], TAG.oid, what).content;
}

function digestHash(oid: Buffer): Hash {
  if (oid.equals(OID.sha256)) return 'sha256';
  if (oid.equals(OID.sha384)) return 'sha384';
  if (oid.equals(OID.sha512)) return 'sha512';
  return refuse('the digest is not SHA-256, SHA-384, or SHA-512');
}

interface SignedDataInfo {
  hash: Hash;
  messageDigest: Buffer;
  /** The signed attributes as the signer hashed them: the SET OF encoding, not the [0] one in the message. */
  signedAttributes: Buffer;
  signature: Buffer;
}

function readSignedData(der: Buffer): SignedDataInfo {
  const root = readTlv(der, 0, der.length, 'the signature');
  if (root.end !== der.length) refuse('the signature has bytes after its end');
  const content = children(expectTag(root, TAG.sequence, 'the signature'), 'the signature', 0);
  if (content.length !== 2) refuse('the signature is not a ContentInfo');
  if (!expectTag(content[0], TAG.oid, 'the content type').content.equals(OID.signedData)) refuse('the signature is not CMS SignedData');
  const wrapped = children(expectTag(content[1], TAG.ctx0Constructed, 'the content'), 'the content', 1);
  if (wrapped.length !== 1) refuse('the content is not one SignedData');
  const fields = children(expectTag(wrapped[0], TAG.sequence, 'SignedData'), 'SignedData', 2);
  if (fields.length < 4) refuse('SignedData is missing fields');
  expectTag(fields[0], TAG.integer, 'the SignedData version');
  expectTag(fields[1], TAG.set, 'the digest algorithms');

  const encap = children(expectTag(fields[2], TAG.sequence, 'the encapsulated content'), 'the encapsulated content', 3);
  if (encap.length < 1 || !expectTag(encap[0], TAG.oid, 'the encapsulated content type').content.equals(OID.data)) {
    refuse('the signed content type is not id-data');
  }
  if (encap.length !== 1) refuse('the signature carries its own content; a tag signature is detached');

  // certificates [0] and crls [1] are optional and ignored: the pin is a key, not a chain.
  let i = 3;
  if (i < fields.length && fields[i].tag === TAG.ctx0Constructed) i++;
  if (i < fields.length && fields[i].tag === TAG.ctx1Constructed) i++;
  if (i !== fields.length - 1) refuse('SignedData has unexpected fields');
  const signerInfos = children(expectTag(fields[i], TAG.set, 'the signer infos'), 'the signer infos', 3);
  if (signerInfos.length !== 1) refuse(`the signature has ${signerInfos.length} signers; a release signature has one`);
  return readSignerInfo(signerInfos[0]);
}

function readSignerInfo(tlv: Tlv): SignedDataInfo {
  const f = children(expectTag(tlv, TAG.sequence, 'the signer info'), 'the signer info', 4);
  if (f.length < 5) refuse('the signer info is missing fields');
  expectTag(f[0], TAG.integer, 'the signer info version');
  if (f[1].tag !== TAG.sequence && f[1].tag !== TAG.ctx0Primitive) refuse('the signer identifier is neither issuer and serial nor a key identifier');
  const hash = digestHash(algorithmOid(f[2], 'the digest algorithm', 4));
  if (f[3].tag !== TAG.ctx0Constructed) refuse('the signature has no signed attributes; a signature over bare content is refused');
  if (f.length < 6) refuse('the signer info is missing fields');
  const { messageDigest } = readSignedAttributes(f[3]);
  const sigAlg = algorithmOid(f[4], 'the signature algorithm', 4);
  const expectedWithHash = hash === 'sha256' ? OID.sha256WithRsa : hash === 'sha384' ? OID.sha384WithRsa : OID.sha512WithRsa;
  if (!sigAlg.equals(OID.rsaEncryption) && !sigAlg.equals(expectedWithHash)) {
    refuse(`the signature algorithm is not RSA PKCS#1 v1.5 with ${hash}`);
  }
  const signature = expectTag(f[5], TAG.octetString, 'the signature value').content;
  if (f.length > 6 && (f.length !== 7 || f[6].tag !== TAG.ctx1Constructed)) refuse('the signer info has unexpected fields');
  if (messageDigest.length !== createHash(hash).digest().length) refuse('the signed digest is the wrong length for its algorithm');
  return { hash, messageDigest, signedAttributes: retagAsSet(f[3].content), signature };
}

function readSignedAttributes(tlv: Tlv): { messageDigest: Buffer } {
  const attrs = children(tlv, 'the signed attributes', 5);
  let contentTypes = 0;
  let messageDigest: Buffer | null = null;
  for (const attr of attrs) {
    const parts = children(expectTag(attr, TAG.sequence, 'a signed attribute'), 'a signed attribute', 6);
    if (parts.length !== 2) refuse('a signed attribute is not type and values');
    const type = expectTag(parts[0], TAG.oid, 'a signed attribute type').content;
    const values = children(expectTag(parts[1], TAG.set, 'the attribute values'), 'the attribute values', 7);
    if (type.equals(OID.contentType)) {
      if (values.length !== 1 || !expectTag(values[0], TAG.oid, 'the content type attribute').content.equals(OID.data)) {
        refuse('the content type attribute is not id-data');
      }
      contentTypes++;
    } else if (type.equals(OID.messageDigest)) {
      if (values.length !== 1 || messageDigest !== null) refuse('the message digest attribute is not one value');
      messageDigest = expectTag(values[0], TAG.octetString, 'the message digest').content;
    }
  }
  if (contentTypes !== 1) refuse('the signed attributes do not name the content type once');
  return { messageDigest: messageDigest ?? refuse('the signed attributes carry no message digest') };
}

/** The signed attributes as the signer hashed them (RFC 5652, 5.4): the same content under the
 *  SET OF tag instead of the [0] IMPLICIT tag the message carries. */
function retagAsSet(content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([TAG.set]), encodeLength(content.length), content]);
}

export function encodeLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function rsaVerifies(hash: Hash, data: Buffer, key: KeyObject, signature: Buffer): boolean {
  try {
    return verify(hash, data, { key, padding: constants.RSA_PKCS1_PADDING }, signature);
  } catch {
    return false;
  }
}
