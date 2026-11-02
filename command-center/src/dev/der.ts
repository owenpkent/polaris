// A small DER encoder for tests, property tests, and fuzz seeds: enough to build a CMS SignedData
// the way a real signer does (update/cms.ts reads them), and to build the shapes a real signer
// never would. Not used by the app. The encoder sorts a SET OF by its encoded elements, as DER
// requires, so a signature built here hashes the attributes the way .NET, smimesign, and OpenSSL do.
import { createHash, sign, type KeyObject } from 'node:crypto';
import { encodeLength, SIGNED_MESSAGE_BEGIN, SIGNED_MESSAGE_END } from '../update/cms.ts';

export function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}
export const sequence = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
/** SET OF, with the elements in DER order. */
export const setOf = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat([...parts].sort(Buffer.compare)));
export const octetString = (bytes: Buffer): Buffer => tlv(0x04, bytes);
export const nullValue = (): Buffer => tlv(0x05, Buffer.alloc(0));
export const utcTime = (text: string): Buffer => tlv(0x17, Buffer.from(text, 'latin1'));
export const explicit = (n: number, ...parts: Buffer[]): Buffer => tlv(0xa0 | n, Buffer.concat(parts));
export const implicitConstructed = explicit;
export const implicitPrimitive = (n: number, content: Buffer): Buffer => tlv(0x80 | n, content);

export function integer(n: number): Buffer {
  const bytes: number[] = [];
  let v = n;
  do { bytes.unshift(v & 0xff); v = Math.floor(v / 256); } while (v > 0);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
}

export function oid(dotted: string): Buffer {
  const arcs = dotted.split('.').map(Number);
  const bytes: number[] = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const chunk: number[] = [arc & 0x7f];
    for (let v = Math.floor(arc / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

export const OIDS = {
  signedData: '1.2.840.113549.1.7.2',
  data: '1.2.840.113549.1.7.1',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  sha1: '1.3.14.3.2.26',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
  rsaEncryption: '1.2.840.113549.1.1.1',
  rsaPss: '1.2.840.113549.1.1.10',
  sha256WithRsa: '1.2.840.113549.1.1.11',
  sha384WithRsa: '1.2.840.113549.1.1.12',
  sha512WithRsa: '1.2.840.113549.1.1.13',
};

export const algorithm = (dotted: string, withNull = true): Buffer => (withNull ? sequence(oid(dotted), nullValue()) : sequence(oid(dotted)));
export const attribute = (type: string, ...values: Buffer[]): Buffer => sequence(oid(type), setOf(...values));

export interface SignOptions {
  hash?: 'sha256' | 'sha384' | 'sha512';
  /** The AlgorithmIdentifier OID written as the signature algorithm; the signing is PKCS#1 v1.5 with `hash` regardless. */
  signatureAlgorithm?: string;
  /** Extra signed attributes, as `attribute()` builds them. */
  extraAttributes?: Buffer[];
  /** Replace the digest written in messageDigest (a forgery shape). */
  messageDigest?: Buffer;
  /** Leave the signed attributes out and sign the payload directly, as RFC 5652 allows and cms.ts refuses. */
  withoutSignedAttributes?: boolean;
  /** The contentType attribute's value (default id-data). */
  contentTypeValue?: string;
  /** Embed the content instead of signing it detached. */
  embedContent?: boolean;
  /** How many copies of the signer info to write. */
  signerCount?: number;
  /** Bytes appended after the ContentInfo. */
  trailing?: Buffer;
  /** Something placed where the certificates would be, e.g. a certificates set. */
  certificates?: Buffer;
}

/** A detached CMS SignedData over `payload`, as a real signer writes it, with knobs for the shapes a verifier must refuse. */
export function signedData(payload: Buffer, privateKey: KeyObject, options: SignOptions = {}): Buffer {
  const hash = options.hash ?? 'sha256';
  const digest = options.messageDigest ?? createHash(hash).update(payload).digest();
  const attrs = options.withoutSignedAttributes ? null : setOf(
    attribute(OIDS.contentType, oid(options.contentTypeValue ?? OIDS.data)),
    attribute(OIDS.messageDigest, octetString(digest)),
    ...(options.extraAttributes ?? []),
  );
  const signed = attrs ?? payload;
  const signature = sign(hash, signed, privateKey);
  const sid = sequence(sequence(setOf(sequence(oid('2.5.4.3'), tlv(0x13, Buffer.from('Test', 'latin1'))))), integer(1));
  const signerInfo = sequence(
    integer(1),
    sid,
    algorithm(OIDS[hash]),
    ...(attrs ? [Buffer.concat([Buffer.from([0xa0]), attrs.subarray(1)])] : []),
    algorithm(options.signatureAlgorithm ?? OIDS.rsaEncryption),
    octetString(signature),
  );
  const encap = options.embedContent ? sequence(oid(OIDS.data), explicit(0, octetString(payload))) : sequence(oid(OIDS.data));
  const body = sequence(
    integer(1),
    setOf(algorithm(OIDS[hash])),
    encap,
    ...(options.certificates ? [options.certificates] : []),
    setOf(...Array.from({ length: options.signerCount ?? 1 }, () => signerInfo)),
  );
  return Buffer.concat([sequence(oid(OIDS.signedData), explicit(0, body)), options.trailing ?? Buffer.alloc(0)]);
}

/** The PEM block git writes around the DER, 64 columns of base64 and a final newline. */
export function signedMessageBlock(der: Buffer): string {
  const b64 = der.toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `${SIGNED_MESSAGE_BEGIN}\n${lines.join('\n')}\n${SIGNED_MESSAGE_END}\n`;
}

/** A tag object as git stores it: the header lines, a blank line, the message, then the signature block. */
export function tagObject(tagName: string, message: string, commit = 'e'.repeat(40)): Buffer {
  return Buffer.from(`object ${commit}\ntype commit\ntag ${tagName}\ntagger Test <test@example.invalid> 1700000000 +0000\n\n${message}\n`, 'utf8');
}
