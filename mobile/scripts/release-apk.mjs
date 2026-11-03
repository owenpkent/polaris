// Builds the release APK, signs it with the EV certificate on the eToken, checks the signature
// against release-signers, and optionally attaches it to the GitHub release or installs it.
//
//   npm --prefix mobile run release [-- --skip-build] [--upload] [--install]   (or `npm run release:apk` at the root)
//
// The signing goes through the Windows certificate store (apksigner with the JDK's SunMSCAPI
// provider), the same path scripts/sign-release.ps1 takes for a tag: the certificate is found by
// its alias, the private key stays on the token, and the token asks for its PIN in its own
// dialog, once per session. No keystore file, no password: nothing is read from an argument, a
// file, or the environment. The dashboard is built and copied in first (--skip-build reuses dist/).
//
// Then the APK is verified the way Android will (one signer, signature schemes v2 and v3), and
// its certificate's public key must be a pinned release signer in release-signers, an ssh-rsa
// line that may sign a tag, so the APK is signed by the same key as the release tags; otherwise
// the file is removed. A lineage file at mobile/android/signing-lineage, made with `apksigner
// rotate` when the certificate is renewed with a new key, is passed through so the new key can
// update an app signed by the old one (mobile/README.md, "When the certificate is renewed").
//
// --upload attaches the APK to the GitHub release for the tag, which must exist (docs/releases.md),
// and only from a clean checkout of that tag. --install runs `adb install -r` on the one
// connected device (or ANDROID_SERIAL). --alias=<name> picks another certificate in the store.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { androidDir, gradlew, requireToolchain, win } from './android-env.mjs'
import { apkName, newestBuildTools, parseVerifyOutput, pinnedSignerFor } from './apkSigning.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MOBILE = join(ROOT, 'mobile')
const LINEAGE = join(androidDir, 'signing-lineage')
const APP_ID = 'com.okstudio.polaris'
// The certificate's friendly name in the Windows store (docs/releases.md, "Current keys" names
// the key). `keytool -list -storetype Windows-MY` prints the aliases.
const KEY_ALIAS = 'OK Studio Inc.'
// Android 9 and later read the signing lineage (scheme v3); an older install signed by the
// previous key cannot update and is reinstalled instead.
const ROTATION_MIN_SDK = '28'

const args = process.argv.slice(2)
const flags = new Set(['--skip-build', '--upload', '--install'])
const aliasArg = args.find((arg) => arg.startsWith('--alias='))
const unknown = args.filter((arg) => !flags.has(arg) && arg !== aliasArg)
if (unknown.length) {
  console.error(`Unknown option: ${unknown.join(' ')}\nUsage: npm run release:apk -- [--skip-build] [--upload] [--install] [--alias=<certificate alias>]`)
  process.exit(1)
}
const skipBuild = args.includes('--skip-build')
const alias = aliasArg ? aliasArg.slice('--alias='.length) : KEY_ALIAS

if (!win) {
  console.error('The release APK is signed on Windows, where the eToken holds the certificate (mobile/README.md, Release build).')
  process.exit(1)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', ...options })
  if (result.status !== 0) fail(`${command} ${commandArgs.join(' ')} failed (${result.status ?? result.signal}).`)
}

// npm and gradlew are .cmd and .bat files, which need a shell; the line is quoted here, since
// a shell gets the arguments concatenated and nothing else.
function runInShell(command, commandArgs, options = {}) {
  const quote = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s)
  const line = [command, ...commandArgs].map(quote).join(' ')
  const result = spawnSync(line, { stdio: 'inherit', shell: true, ...options })
  if (result.status !== 0) fail(`${line} failed (${result.status ?? result.signal}).`)
}

function output(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', ...options })
  return { status: result.status, text: `${result.stdout || ''}${result.stderr || ''}` }
}

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const mobileVersion = JSON.parse(readFileSync(join(MOBILE, 'package.json'), 'utf8')).version
if (version !== mobileVersion) fail(`package.json says ${version} and mobile/package.json says ${mobileVersion}: bump them together (docs/releases.md).`)
const tag = `v${version}`
const name = apkName(version)

const { jdk, sdk } = requireToolchain()
const buildTools = newestBuildTools(existsSync(join(sdk, 'build-tools')) ? readdirSync(join(sdk, 'build-tools')) : [])
if (!buildTools) fail(`No build-tools under ${sdk}. Install one with sdkmanager (mobile/README.md).`)
const apksignerJar = join(sdk, 'build-tools', buildTools, 'lib', 'apksigner.jar')
const zipalign = join(sdk, 'build-tools', buildTools, 'zipalign.exe')
if (!existsSync(apksignerJar) || !existsSync(zipalign)) fail(`build-tools ${buildTools} is missing apksigner or zipalign.`)

// apksigner needs a Java with the Windows certificate store provider (module jdk.crypto.mscapi).
// Android Studio's bundled runtime leaves it out, so this is often not the JDK Gradle uses.
function hasStoreProvider(home) {
  if (!home) return false
  const java = join(home, 'bin', 'java.exe')
  return existsSync(java) && output(java, ['--list-modules']).text.includes('jdk.crypto.mscapi')
}
function javaHomeOnPath() {
  // `java` here is whatever the PATH resolves, so it goes through the shell as one fixed line.
  const m = /java\.home = (.+)/.exec(output('java -XshowSettings:properties -version', [], { shell: true }).text)
  return m ? m[1].trim() : undefined
}
const signingJava = [process.env.JAVA_HOME, javaHomeOnPath(), jdk].find(hasStoreProvider)
if (!signingJava) {
  fail('No Java with the Windows certificate store provider (jdk.crypto.mscapi) found: Android Studio\'s bundled runtime leaves it out. Put an Adoptium JDK or JRE 21 on the PATH, or name one in JAVA_HOME.')
}
const javaExe = join(signingJava, 'bin', 'java.exe')
const apksigner = (apksignerArgs, options = {}) => [javaExe, ['-jar', apksignerJar, ...apksignerArgs], options]

if (!skipBuild) runInShell('npm', ['run', 'build'], { cwd: ROOT })
if (!existsSync(join(ROOT, 'dist', 'index.html'))) fail('dist/index.html is missing: run `npm run build` at the repo root, or drop --skip-build.')
runInShell('npm', ['run', 'sync'], { cwd: MOBILE })

runInShell(gradlew, ['assembleRelease'], { cwd: androidDir, env: { ...process.env, JAVA_HOME: jdk, ANDROID_HOME: sdk } })
const outDir = join(androidDir, 'app', 'build', 'outputs', 'apk', 'release')
const unsigned = join(outDir, 'app-release-unsigned.apk')
if (!existsSync(unsigned)) fail(`Gradle made no ${unsigned}.`)
const aligned = join(outDir, 'app-release-aligned.apk')
const out = join(outDir, name)
for (const stale of [aligned, out, `${out}.idsig`]) rmSync(stale, { force: true })

run(zipalign, ['-p', '-f', '4', unsigned, aligned])

const lineage = existsSync(LINEAGE)
console.log(`Signing ${name} as "${alias}"${lineage ? ' with the signing lineage' : ''} (the eToken may ask for its PIN)`)
const signed = spawnSync(...apksigner([
  'sign',
  '--ks', 'NONE', '--ks-type', 'Windows-MY', '--ks-key-alias', alias,
  // The Windows store has no password and ignores this; apksigner only insists on being given one.
  '--ks-pass', 'pass:windows-store',
  '--v2-signing-enabled', 'true', '--v3-signing-enabled', 'true', '--v4-signing-enabled', 'false',
  ...(lineage ? ['--lineage', LINEAGE, '--rotation-min-sdk-version', ROTATION_MIN_SDK] : []),
  '--out', out, aligned,
], { stdio: 'inherit' }))
rmSync(aligned, { force: true })
if (signed.status !== 0) {
  rmSync(out, { force: true })
  fail(`apksigner failed (${signed.status ?? signed.signal}). Is the eToken plugged in, and is "${alias}" the certificate's alias in the store?`)
}

// The check an install makes: verified, v2 and v3, one signer, and that signer's key pinned.
const verify = output(...apksigner(['verify', '--verbose', '--print-certs-pem', out]))
const parsed = parseVerifyOutput(verify.text)
let problem = null
if (verify.status !== 0 || !parsed.verifies) problem = `apksigner does not verify it:\n${verify.text.trim()}`
else if (!parsed.v2 || !parsed.v3) problem = 'it lacks a v2 or v3 signature'
else if (parsed.signers !== 1 || parsed.certs.length < 1) problem = `it has ${parsed.signers} signers`
let signer = null
if (!problem) {
  try {
    signer = pinnedSignerFor(parsed.certs[0], readFileSync(join(ROOT, 'release-signers'), 'utf8'))
  } catch (err) {
    problem = `its certificate or release-signers could not be read: ${err instanceof Error ? err.message : String(err)}`
  }
  if (!problem && !signer) problem = 'its signing certificate is not a pinned release signer in release-signers'
}
if (problem) {
  rmSync(out, { force: true })
  fail(`${name} was removed: ${problem}.`)
}
console.log(`Made ${out}\nSigned by ${signer} (release-signers), signature schemes v2 and v3.`)

if (args.includes('--install')) {
  const adb = join(sdk, 'platform-tools', 'adb.exe')
  if (!existsSync(adb)) fail(`adb not found at ${adb}. Install the SDK's platform-tools.`)
  const install = output(adb, ['install', '-r', out])
  process.stdout.write(install.text)
  if (install.status !== 0) {
    if (install.text.includes('INSTALL_FAILED_UPDATE_INCOMPATIBLE')) {
      fail(`The installed app was signed with another key (the debug key, or a certificate before a rotation). Remove it first: adb uninstall ${APP_ID}`)
    }
    fail('adb install failed.')
  }
}

if (args.includes('--upload')) {
  const git = (gitArgs) => output('git', gitArgs, { cwd: ROOT })
  if (git(['status', '--porcelain']).text.trim()) fail('The checkout has changes: upload only from a clean checkout of the release tag.')
  const tags = git(['tag', '--points-at', 'HEAD']).text.split(/\r?\n/).map((t) => t.trim())
  if (!tags.includes(tag)) fail(`HEAD is not ${tag}: check the tag out first (git checkout ${tag}) so the APK is built from the release.`)
  if (output('gh', ['release', 'view', tag], { cwd: ROOT }).status !== 0) fail(`There is no GitHub release for ${tag} yet: make it first (docs/releases.md, step 7).`)
  run('gh', ['release', 'upload', tag, out, '--clobber'], { cwd: ROOT })
  console.log(`Attached ${name} to the ${tag} release. The App update card in Settings offers it.`)
}
