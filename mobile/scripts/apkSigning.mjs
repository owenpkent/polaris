// The pure parts of release-apk.mjs: reading apksigner's verify output and matching the signing
// certificate against the release signers. Tested in apkSigning.test.js on a real verify output
// (fixtures/apksigner-verify.txt, from an APK signed with the EV certificate).
import { X509Certificate } from 'node:crypto'
import { parseAllowedSigners, x509PinnedKeys } from '../../command-center/src/update/signers.ts'

export function apkName(version) {
  return `polaris-${version}.apk`
}

/** The newest build-tools folder name by version, or undefined when none is a version. */
export function newestBuildTools(names) {
  const parsed = names
    .map((name) => ({ name, v: name.split('.').map(Number) }))
    .filter(({ v }) => v.length === 3 && v.every((n) => Number.isInteger(n) && n >= 0))
  parsed.sort((a, b) => a.v[0] - b.v[0] || a.v[1] - b.v[1] || a.v[2] - b.v[2])
  return parsed.at(-1)?.name
}

/** What `apksigner verify --verbose --print-certs-pem` printed: whether the APK verifies, which
 *  of the v2 and v3 schemes did, how many signers there are, and each certificate as PEM. */
export function parseVerifyOutput(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim())
  const scheme = (n) => lines.some((line) => line === `Verified using v${n} scheme (APK Signature Scheme v${n}): true`)
  const count = lines.find((line) => line.startsWith('Number of signers:'))
  return {
    verifies: lines.includes('Verifies'),
    v2: scheme(2),
    v3: scheme(3),
    signers: count ? Number(count.slice('Number of signers:'.length).trim()) || 0 : 0,
    certs: [...text.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)].map((m) => m[0].replace(/\r\n/g, '\n')),
  }
}

/** The principal of the release-signers line whose key is this certificate's, or null. Only a
 *  line an X.509 tag signature may verify against counts (x509PinnedKeys), so an APK is accepted
 *  by exactly the keys that may sign a release tag. */
export function pinnedSignerFor(certPem, signersText) {
  const certKey = new X509Certificate(certPem).publicKey
  for (const pinned of x509PinnedKeys(parseAllowedSigners(signersText))) {
    if (pinned.key.equals(certKey)) return pinned.name
  }
  return null
}
