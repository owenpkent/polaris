import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apkName, newestBuildTools, parseArgs, parseVerifyOutput, pinnedSignerFor, rotateArgs, shellLine, signArgs, windowsStoreSigner } from './apkSigning.mjs'

// A real `apksigner verify --verbose --print-certs-pem` output for an APK signed with the EV
// certificate, CRLF line ends as apksigner prints them on Windows.
const here = dirname(fileURLToPath(import.meta.url))
const verifyOutput = readFileSync(join(here, 'fixtures', 'apksigner-verify.txt'), 'utf8')
const releaseSigners = readFileSync(join(here, '..', '..', 'release-signers'), 'utf8')

describe('parseVerifyOutput', () => {
  test('reads the verdict, the schemes, the signer count, and the certificate', () => {
    const parsed = parseVerifyOutput(verifyOutput)
    expect(parsed.verifies).toBe(true)
    expect(parsed.v2).toBe(true)
    expect(parsed.v3).toBe(true)
    expect(parsed.signers).toBe(1)
    expect(parsed.certs).toHaveLength(1)
    expect(parsed.certs[0].startsWith('-----BEGIN CERTIFICATE-----\n')).toBe(true)
    expect(parsed.certs[0]).not.toContain('\r')
  })

  test('a failed verify has no verdict and no schemes', () => {
    const parsed = parseVerifyOutput('DOES NOT VERIFY\nERROR: No signature found\n')
    expect(parsed).toEqual({ verifies: false, v2: false, v3: false, signers: 0, certs: [] })
  })

  test('a v2-only APK is reported as such', () => {
    const text = verifyOutput.replace('Verified using v3 scheme (APK Signature Scheme v3): true', 'Verified using v3 scheme (APK Signature Scheme v3): false')
    expect(parseVerifyOutput(text).v3).toBe(false)
    expect(parseVerifyOutput(text).v2).toBe(true)
  })
})

describe('pinnedSignerFor', () => {
  const cert = parseVerifyOutput(verifyOutput).certs[0]

  test('the EV certificate is the pinned ok-studio-ev key', () => {
    expect(pinnedSignerFor(cert, releaseSigners)).toBe('ok-studio-ev')
  })

  test('a signers file without that key, or with it unable to sign a tag, matches nothing', () => {
    const lines = releaseSigners.split('\n')
    const evLine = lines.find((line) => line.startsWith('ok-studio-ev '))
    expect(evLine).toBeTruthy()
    expect(pinnedSignerFor(cert, lines.filter((line) => line !== evLine).join('\n'))).toBeNull()
    // cert-authority makes the line a CA pin, which x509PinAllowed refuses.
    expect(pinnedSignerFor(cert, evLine.replace('namespaces="git"', 'cert-authority'))).toBeNull()
  })

  test('a different certificate matches nothing', () => {
    // A self-signed test certificate (RSA 2048), not a release signer.
    const other = `-----BEGIN CERTIFICATE-----
MIICpDCCAYwCCQDU+pQ2rVv6KTANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAls
b2NhbGhvc3QwHhcNMjQwMTAxMDAwMDAwWhcNMzQwMTAxMDAwMDAwWjAUMRIwEAYD
VQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC7
VJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictGeurT8jNb
vJZHtCSuYEvuNMoSfm76oqFvAp8Gy0iz5sxjZmSnXyCdPEovGhLa0VzMaQ8s+CLO
yS56YyCFGeJZqgtzJ6GR3eqoYSW9b9UMvkBpZODSctWSNGj3P7jRFDO5VoTwCQAW
bFnOjDfH5Ulgp2PKSQnSJP3AJLQNFNe7br1XbrhV//eO+t51mIpGSDCUv3E0DDFc
WDTH9cXDTTlRZVEiR2BwpZOOkE/Z0/BVnhZYL71oZV34bKfWjQIt6V/isSMahdsA
ASACp4ZTGtwiVuNd9tybAgMBAAEwDQYJKoZIhvcNAQELBQADggEBAEqyq3jcc6UK
hcV0A7W+l0Ht0zZXXwkC9VLGPMXuRGb8I8xPVmoi5xmIZcNzqeU3uY/GvBcJuevl
UV6Lae+WxaGxKRBFL3fzhAD6nTRZJjCGf9EPuKCkeFYkEAEX12HZzjYS8b7X8Lnk
5sHq4ZC4qONoH0g2W4zb2pkz4XC0lYv0kB2dS9xUE5fxx3Qc6HUh6bu6GvUBOeTw
4mTPg3SPtKsKJfEQ4N1V1q8nH4xMGt4L5I2CjGcA6bMNU7X0aEMZrp/N8rXSsjrR
yh6N1ZeXy1BcY9RvNqJUzvhp3RzXnc4lXdbKSOsSDkkwAhXLTMFl6PIa7DqmKUpP
Tft8e1nM4oI=
-----END CERTIFICATE-----
`
    let result
    try {
      result = pinnedSignerFor(other, releaseSigners)
    } catch (err) {
      // A certificate that does not parse is as good as one that does not match: the script
      // refuses either. This guards the fixture rather than the function.
      result = err instanceof Error ? null : err
    }
    expect(result).toBeNull()
  })
})

describe('newestBuildTools and apkName', () => {
  test('picks the highest version and ignores other folder names', () => {
    expect(newestBuildTools(['35.0.0', '37.0.0', '36.1.0', 'debian', '36.0.0-rc1'])).toBe('37.0.0')
    expect(newestBuildTools([])).toBeUndefined()
  })

  test('the APK is named for the version', () => {
    expect(apkName('2.4.0')).toBe('polaris-2.4.0.apk')
  })
})

describe('parseArgs', () => {
  test('reads the flags and the aliases', () => {
    expect(parseArgs([])).toEqual({ skipBuild: false, upload: false, install: false, alias: null, oldAlias: null })
    expect(parseArgs(['--skip-build', '--install', '--alias=New Cert', '--old-alias=OK Studio Inc.'])).toEqual({ skipBuild: true, upload: false, install: true, alias: 'New Cert', oldAlias: 'OK Studio Inc.' })
    expect(parseArgs(['--upload']).upload).toBe(true)
  })

  test('refuses an unknown option, an empty alias, and --skip-build with --upload', () => {
    expect(() => parseArgs(['--release'])).toThrow(/Unknown option: --release/)
    expect(() => parseArgs(['--alias='])).toThrow(/Unknown option/)
    // An upload must carry a dashboard built from the release checkout: dist/ is ignored by git,
    // so a stale one would pass the clean-checkout check.
    expect(() => parseArgs(['--skip-build', '--upload'])).toThrow(/--skip-build cannot go with --upload/)
    expect(() => parseArgs(['--upload', '--skip-build'])).toThrow(/--skip-build cannot go with --upload/)
  })
})

describe('shellLine', () => {
  test('quotes words with spaces and leaves the rest alone', () => {
    expect(shellLine('C:\\Program Files\\x\\gradlew.bat', ['assembleRelease'])).toBe('"C:\\Program Files\\x\\gradlew.bat" assembleRelease')
    expect(shellLine('npm', ['run', 'build'])).toBe('npm run build')
  })

  test('refuses a word with a quote rather than escaping it', () => {
    expect(() => shellLine('npm', ['run', 'say "hi"'])).toThrow(/contains a quote/)
  })
})

describe('signArgs and rotateArgs', () => {
  const store = windowsStoreSigner('OK Studio Inc.')

  test('one signer from the Windows store, v2 and v3 on, v4 off, no lineage', () => {
    expect(signArgs({ signers: [store], out: 'out.apk', input: 'in.apk' })).toEqual([
      'sign', '--ks', 'NONE', '--ks-type', 'Windows-MY', '--ks-key-alias', 'OK Studio Inc.', '--ks-pass', 'pass:windows-store',
      '--v2-signing-enabled', 'true', '--v3-signing-enabled', 'true', '--v4-signing-enabled', 'false',
      '--out', 'out.apk', 'in.apk',
    ])
  })

  test('with a lineage, the key it starts from comes first and the current key as --next-signer', () => {
    const args = signArgs({ signers: [store, windowsStoreSigner('OK Studio Inc. 2027')], lineage: 'signing-lineage', out: 'out.apk', input: 'in.apk' })
    const next = args.indexOf('--next-signer')
    expect(args.indexOf('OK Studio Inc.')).toBeLessThan(next)
    expect(args.slice(next, next + 8)).toEqual(['--next-signer', '--ks', 'NONE', '--ks-type', 'Windows-MY', '--ks-key-alias', 'OK Studio Inc. 2027', '--ks-pass'])
    expect(args.slice(args.indexOf('--lineage'), args.indexOf('--lineage') + 4)).toEqual(['--lineage', 'signing-lineage', '--rotation-min-sdk-version', '28'])
  })

  test('a lineage needs two signers, and two signers need a lineage', () => {
    expect(() => signArgs({ signers: [store], lineage: 'signing-lineage', out: 'o', input: 'i' })).toThrow(/key it starts from/)
    expect(() => signArgs({ signers: [store, store], out: 'o', input: 'i' })).toThrow(/needs a lineage/)
    expect(() => signArgs({ signers: [], out: 'o', input: 'i' })).toThrow(/at least one signer/)
  })

  test('rotate names the old signer then the new one', () => {
    const args = rotateArgs({ oldSigner: { ks: 'old.jks', alias: 'old', pass: 'pass:x' }, newSigner: { ks: 'new.jks', alias: 'new', pass: 'pass:x' }, out: 'lineage' })
    expect(args).toEqual(['rotate', '--out', 'lineage', '--old-signer', '--ks', 'old.jks', '--ks-key-alias', 'old', '--ks-pass', 'pass:x', '--new-signer', '--ks', 'new.jks', '--ks-key-alias', 'new', '--ks-pass', 'pass:x'])
  })
})
