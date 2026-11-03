// The signing lineage path of release-apk.mjs, against the real apksigner with throwaway
// keys: a lineage is made, extended once with --in for a third key, an archive is signed the way the script signs (the key the lineage
// starts from and the current key), and it verifies with v2 and v3 and one signer. Signing with
// the current key alone, which an earlier version of the script did, is refused by apksigner, so
// the test pins that too. Needs a JDK (keytool and jar) and the Android build-tools (apksigner):
// without them it is skipped, so the plain unit run never needs an SDK. CI runs it in the
// android.yml release-build job, where both exist.
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findJdk, findSdk, win } from './android-env.mjs'

const here = dirname(fileURLToPath(import.meta.url))
import { newestBuildTools, parseVerifyOutput, rotateArgs, signArgs, signerArgs } from './apkSigning.mjs'

const jdk = findJdk()
const sdk = findSdk()
const buildTools = sdk && existsSync(join(sdk, 'build-tools')) ? newestBuildTools(readdirSync(join(sdk, 'build-tools'))) : undefined
const apksignerJar = buildTools ? join(sdk, 'build-tools', buildTools, 'lib', 'apksigner.jar') : undefined
const ready = Boolean(jdk && apksignerJar && existsSync(apksignerJar))
const exe = (name) => join(jdk, 'bin', win ? `${name}.exe` : name)

function tool(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  return { status: result.status, text: `${result.stdout || ''}${result.stderr || ''}` }
}

// Two key pairs, a rotate, a sign, and a verify each start a JVM, and the key generation alone
// can take tens of seconds on a loaded machine, so the setup and the tests get their own
// timeouts in place of Vitest's 10 seconds.
const SLOW = 180_000

describe.skipIf(!ready)('signing with a lineage', () => {
  let dir
  const signer = (name) => ({ ks: `${name}.jks`, alias: name, pass: 'pass:throwaway' })
  const apksigner = (args) => tool(exe('java'), ['-jar', apksignerJar, ...args], dir)

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'polaris-lineage-'))
    for (const name of ['old', 'new', 'third']) {
      const made = tool(exe('keytool'), ['-genkeypair', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '1', '-dname', `CN=${name}`, '-alias', name, '-storepass', 'throwaway', '-keypass', 'throwaway', '-keystore', `${name}.jks`], dir)
      if (made.status !== 0) throw new Error(made.text)
    }
    // apksigner reads the SDK range from AndroidManifest.xml, so the archive carries the app's
    // (fixtures/AndroidManifest.xml, the binary one from a release build) next to a stand-in file.
    copyFileSync(join(here, 'fixtures', 'AndroidManifest.xml'), join(dir, 'AndroidManifest.xml'))
    writeFileSync(join(dir, 'a.txt'), 'hello\n')
    const zipped = tool(exe('jar'), ['cf', 'in.zip', 'AndroidManifest.xml', 'a.txt'], dir)
    if (zipped.status !== 0) throw new Error(zipped.text)
    const rotated = apksigner(rotateArgs({ oldSigner: signer('old'), newSigner: signer('new'), out: 'lineage' }))
    if (rotated.status !== 0) throw new Error(rotated.text)
    // The second renewal extends the first lineage: it is read with --in and its current leaf
    // (the newest certificate so far) is the old signer, so the chain keeps every key.
    const extended = apksigner(rotateArgs({ oldSigner: signer('new'), newSigner: signer('third'), out: 'lineage3', in: 'lineage' }))
    if (extended.status !== 0) throw new Error(extended.text)
  }, SLOW)

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('the current key alone is refused: the lineage needs the key it starts from', () => {
    // signArgs refuses this pairing itself (apkSigning.test.js); this is apksigner's own answer
    // to the arguments an earlier version of the script built, so the guard stays grounded.
    const one = apksigner(['sign', ...signerArgs(signer('new')), '--lineage', 'lineage', '--rotation-min-sdk-version', '28', '--out', 'one.apk', 'in.zip'])
    expect(one.status).not.toBe(0)
    expect(one.text).toMatch(/oldest signer/)
  }, SLOW)

  test('the old key and the current key sign, and the result verifies with v2 and v3 and one signer', () => {
    const two = apksigner(signArgs({ signers: [signer('old'), signer('new')], lineage: 'lineage', out: 'two.apk', input: 'in.zip' }))
    expect(two.status, two.text).toBe(0)
    const verified = apksigner(['verify', '--verbose', '--print-certs-pem', 'two.apk'])
    expect(verified.status, verified.text).toBe(0)
    const parsed = parseVerifyOutput(verified.text)
    expect(parsed.verifies).toBe(true)
    expect(parsed.v2).toBe(true)
    expect(parsed.v3).toBe(true)
    expect(parsed.signers).toBe(1)
    // The certificate apksigner reports first is the current key's, the one pinnedSignerFor checks.
    expect(parsed.certs.length).toBeGreaterThanOrEqual(1)
    expect(verified.text).toContain('CN=new')
  }, SLOW)

  test('a second renewal extends the lineage to old, new, third, and the key it starts from and the newest sign', () => {
    const printed = apksigner(['lineage', '--in', 'lineage3', '--print-certs'])
    expect(printed.status, printed.text).toBe(0)
    const order = ['CN=old', 'CN=new', 'CN=third'].map((subject) => printed.text.indexOf(subject))
    expect(order.every((i) => i >= 0), printed.text).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))

    const three = apksigner(signArgs({ signers: [signer('old'), signer('third')], lineage: 'lineage3', out: 'three.apk', input: 'in.zip' }))
    expect(three.status, three.text).toBe(0)
    const verified = apksigner(['verify', '--verbose', '--print-certs-pem', 'three.apk'])
    expect(verified.status, verified.text).toBe(0)
    const parsed = parseVerifyOutput(verified.text)
    expect(parsed.verifies).toBe(true)
    expect(parsed.v2).toBe(true)
    expect(parsed.v3).toBe(true)
    expect(parsed.signers).toBe(1)
    expect(verified.text).toContain('CN=third')
  }, SLOW)
})
