// The pure parts of release-apk.mjs: reading apksigner's verify output and matching the signing
// certificate against the release signers. Tested in apkSigning.test.js on a real verify output
// (fixtures/apksigner-verify.txt, from an APK signed with the EV certificate).
import { X509Certificate } from 'node:crypto'
import { parseAllowedSigners, x509PinnedKeys } from '../../command-center/src/update/signers.ts'

export function apkName(version) {
  return `polaris-${version}.apk`
}

/** The script's options. Throws on an unknown one, and on --skip-build with --upload: an APK that
 *  goes to a release must carry the dashboard built from the release commit, and dist/ is
 *  ignored by git, so a stale build would pass the clean-checkout check unseen. */
export function parseArgs(argv) {
  const options = { skipBuild: false, upload: false, install: false, alias: null, oldAlias: null }
  for (const arg of argv) {
    if (arg === '--skip-build') options.skipBuild = true
    else if (arg === '--upload') options.upload = true
    else if (arg === '--install') options.install = true
    else if (arg.startsWith('--alias=') && arg.length > '--alias='.length) options.alias = arg.slice('--alias='.length)
    else if (arg.startsWith('--old-alias=') && arg.length > '--old-alias='.length) options.oldAlias = arg.slice('--old-alias='.length)
    else throw new Error(`Unknown option: ${arg}\nUsage: npm run release:apk -- [--skip-build] [--upload] [--install] [--alias=<certificate alias>] [--old-alias=<alias of the key a lineage starts from>]`)
  }
  if (options.skipBuild && options.upload) throw new Error('--skip-build cannot go with --upload: the APK attached to a release is built from the release commit, and dist/ is not checked by git.')
  return options
}

/** A command line for a shell (npm and gradlew are .cmd and .bat files, which need one), each
 *  word quoted when it has a space. A word with a quote in it is refused rather than escaped:
 *  none of ours has one, and cmd.exe and sh disagree on how to escape it. */
export function shellLine(command, args) {
  return [command, ...args].map((word) => {
    if (word.includes('"')) throw new Error(`cannot pass "${word}" through a shell: it contains a quote`)
    return /\s/.test(word) ? `"${word}"` : word
  }).join(' ')
}

/** apksigner's options for one signer: a keystore file with its type and password, or the
 *  Windows certificate store (`ks: 'NONE', ksType: 'Windows-MY'`), which has no password and
 *  ignores the one apksigner insists on being given. */
export function signerArgs({ ks, ksType, alias, pass }) {
  return ['--ks', ks, ...(ksType ? ['--ks-type', ksType] : []), '--ks-key-alias', alias, '--ks-pass', pass]
}

export function windowsStoreSigner(alias) {
  return { ks: 'NONE', ksType: 'Windows-MY', alias, pass: 'pass:windows-store' }
}

/** `apksigner sign` arguments. Without a lineage, one signer. With one, the signers are the key
 *  the lineage starts from and the current key, in that order: apksigner refuses a lineage
 *  without the oldest signer, which still makes the v2 signature for devices before Android 9,
 *  while the current key makes the v3 one that those devices and newer ones install over. */
export function signArgs({ signers, lineage = null, rotationMinSdk = '28', out, input, minSdk = null, maxSdk = null }) {
  if (!signers.length) throw new Error('signArgs needs at least one signer')
  if (lineage && signers.length < 2) throw new Error('signing with a lineage needs the key it starts from as well as the current key')
  if (!lineage && signers.length > 1) throw new Error('more than one signer needs a lineage')
  const [first, ...rest] = signers
  return [
    'sign',
    ...signerArgs(first),
    ...rest.flatMap((s) => ['--next-signer', ...signerArgs(s)]),
    '--v2-signing-enabled', 'true', '--v3-signing-enabled', 'true', '--v4-signing-enabled', 'false',
    ...(lineage ? ['--lineage', lineage, '--rotation-min-sdk-version', String(rotationMinSdk)] : []),
    ...(minSdk ? ['--min-sdk-version', String(minSdk)] : []),
    ...(maxSdk ? ['--max-sdk-version', String(maxSdk)] : []),
    '--out', out, input,
  ]
}

/** `apksigner rotate` arguments: the lineage in which `oldSigner` vouches for `newSigner`. */
export function rotateArgs({ oldSigner, newSigner, out }) {
  return ['rotate', '--out', out, '--old-signer', ...signerArgs(oldSigner), '--new-signer', ...signerArgs(newSigner)]
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
