// Builds, runs, and releases the Constellation desktop app in desktop/ (Tauri, Windows only).
// The plan and the decisions behind it are in initiatives/desktop-app.md.
//
//   node scripts/desktop.mjs prepare              build the dashboard, then stage the server bundle,
//                                                node.exe, and dist/ under desktop/src-tauri
//   node scripts/desktop.mjs dev                  prepare, then `tauri dev`: a debug build that opens
//   node scripts/desktop.mjs build [--unsigned]   prepare, then `tauri build`: the installer lands in
//                                                desktop/src-tauri/target/release/bundle/nsis
//   node scripts/desktop.mjs release [--unsigned] [--dry-run] [--notes "text"]
//                                                build, signature check, latest.json, then a GitHub
//                                                release on the releases repo (unless --dry-run)
//   node scripts/desktop.mjs version <x.y.z>      set the app version in tauri.conf.json
//   node scripts/desktop.mjs test                 cargo test for the shell's own helpers
//
// Options: --skip-dashboard reuses dist/ from the last `npm run build`; --debug makes a debug build.
//
// Signing. A code-signed build needs the OK Studio EV token plugged in, run from a normal (not
// elevated) shell, since the token is invisible to elevated processes. Tauri calls signtool itself
// with the thumbprint, digest, and timestamp server from tauri.conf.json (the same settings as
// alpha-osk's build/windows/sign.py). --unsigned skips that and nothing else. The updater's own
// signature comes from the minisign key at ~/.tauri/constellation.key, made once with
// `npx tauri signer generate`; its public half is the pubkey in tauri.conf.json, and every build,
// signed or not, carries it. Lose that key and no installed copy can ever update again: keep it
// in the password manager with the backup passphrase.

import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CC = join(ROOT, 'command-center')
const DESKTOP = join(ROOT, 'desktop')
const SRC_TAURI = join(DESKTOP, 'src-tauri')
const CONF = join(SRC_TAURI, 'tauri.conf.json')
const RESOURCES = join(SRC_TAURI, 'resources')
const BINARIES = join(SRC_TAURI, 'binaries')
const BUNDLE_DIR = join(SRC_TAURI, 'target', 'release', 'bundle', 'nsis')
const RELEASE_DIR = join(DESKTOP, 'release')
const TAURI_CLI = join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')

// The only build this script knows. The sidecar name carries the target triple, as Tauri wants.
const TRIPLE = 'x86_64-pc-windows-msvc'
// Release binaries live apart from the private source repo, as alpha-osk's do, because the
// updater fetches latest.json and the installer without any credential.
const RELEASES_REPO = 'owenpkent/constellation-releases'
const SIGNING_KEY = join(homedir(), '.tauri', 'constellation.key')

function usage(message) {
  if (message) console.error(message)
  console.error(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'))
  process.exit(2)
}

function parseArgs(argv) {
  const args = { command: argv[0], rest: [], skipDashboard: false, unsigned: false, debug: false, dryRun: false, notes: undefined }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--skip-dashboard') args.skipDashboard = true
    else if (a === '--unsigned') args.unsigned = true
    else if (a === '--debug') args.debug = true
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--notes') args.notes = argv[++i]
    else if (a.startsWith('--')) usage(`Unknown option: ${a}`)
    else args.rest.push(a)
  }
  return args
}

/** Run one step to completion; a failure ends the script with the step's exit code. */
function run(command, commandArgs, { cwd = ROOT, env = process.env, shell = false } = {}) {
  console.log(`> ${command} ${commandArgs.join(' ')}`)
  const result = spawnSync(command, commandArgs, { cwd, env, stdio: 'inherit', shell })
  if (result.error) { console.error(result.error.message); process.exit(1) }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function tauri(cliArgs, env = process.env) {
  if (!existsSync(TAURI_CLI)) usage('The Tauri CLI is not installed: run npm install at the repo root.')
  run(process.execPath, [TAURI_CLI, ...cliArgs], { cwd: DESKTOP, env })
}

function readConf() {
  return JSON.parse(readFileSync(CONF, 'utf8'))
}

// ---------------------------------------------------------------------------------------- prepare

async function prepare({ skipDashboard }) {
  if (process.platform !== 'win32' || process.arch !== 'x64') usage('The desktop app is built on 64-bit Windows only.')
  if (!existsSync(join(ROOT, 'node_modules')) || !existsSync(join(CC, 'node_modules'))) {
    usage('Install packages first: npm install; npm --prefix command-center install')
  }

  if (skipDashboard) {
    if (!existsSync(join(ROOT, 'dist', 'index.html'))) usage('--skip-dashboard needs a dist/ from an earlier npm run build.')
  } else {
    run('npm', ['run', 'build'], { shell: true })
  }

  rmSync(RESOURCES, { recursive: true, force: true })

  // The server as one ESM file. It stays two folders below a package.json copy because
  // command-center/src/http/rest.ts reads its version from `here/../../package.json`, and
  // command-center/src/config.ts takes `here/../..` as the repo root (the app overrides that
  // with CC_REPO_ROOT or skips the import job; see desktop/src-tauri/src/daemon.rs). CJS packages
  // that require node builtins need a real `require`, hence the banner.
  const { build } = await import('esbuild')
  const bundleDir = join(RESOURCES, 'command-center', 'src', 'bundle')
  mkdirSync(bundleDir, { recursive: true })
  await build({
    entryPoints: [join(CC, 'src', 'cli.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: join(bundleDir, 'cli.mjs'),
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    logLevel: 'warning',
  })
  copyFileSync(join(CC, 'package.json'), join(RESOURCES, 'command-center', 'package.json'))
  console.log(`Server bundle: ${join(bundleDir, 'cli.mjs')}`)

  cpSync(join(ROOT, 'dist'), join(RESOURCES, 'dist'), { recursive: true })
  console.log(`Dashboard: ${join(RESOURCES, 'dist')}`)

  // The Node that runs this script becomes the sidecar, so the app runs the server on the same
  // Node it was built and tested with.
  mkdirSync(BINARIES, { recursive: true })
  const sidecar = join(BINARIES, `node-${TRIPLE}.exe`)
  copyFileSync(process.execPath, sidecar)
  console.log(`Sidecar: ${sidecar} (${process.version})`)
}

// ------------------------------------------------------------------------------------------ build

function certificateInStore(thumbprint) {
  const result = spawnSync('certutil', ['-user', '-store', 'My', thumbprint], { encoding: 'utf8' })
  return result.status === 0
}

// Two signatures, independent of each other. The updater's minisign signature is what an
// installed app checks before it installs a release, so every build carries it. The Windows
// code signature is what SmartScreen looks at when the installer is run by hand; --unsigned
// skips it, for builds made while the EV token is not at hand. An unsigned 0.1.0 updates itself
// to a signed 0.2.0 without trouble: the updater key is the same.
function updaterEnv() {
  const conf = readConf()
  if (!conf.plugins?.updater?.pubkey || conf.plugins.updater.pubkey === 'PLACEHOLDER') {
    usage('tauri.conf.json has no updater pubkey. Run: npx tauri signer generate -w ~/.tauri/constellation.key, then paste the public key.')
  }
  if (!existsSync(SIGNING_KEY)) usage(`The updater signing key is missing: ${SIGNING_KEY}`)
  // The CLI reads the key itself from this variable (the _PATH variant is not honoured by every
  // release). It goes to the child's environment only, never to a command line or a log.
  return { ...process.env, TAURI_SIGNING_PRIVATE_KEY: readFileSync(SIGNING_KEY, 'utf8').trim(), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' }
}

function requireCertificate() {
  const thumbprint = readConf().bundle.windows.certificateThumbprint
  if (!certificateInStore(thumbprint)) {
    usage(`The code signing certificate ${thumbprint} is not in the user store. Plug in the EV token and run this from a normal (not elevated) shell, or build with --unsigned.`)
  }
}

async function build(args) {
  await prepare(args)
  const cliArgs = ['build']
  if (args.debug) cliArgs.push('--debug')
  if (args.unsigned) {
    // A JSON merge patch over tauri.conf.json: null removes the thumbprint, so signtool never runs.
    cliArgs.push('--config', JSON.stringify({ bundle: { windows: { certificateThumbprint: null } } }))
  } else {
    requireCertificate()
  }
  tauri(cliArgs, updaterEnv())
  console.log(`\nInstaller folder: ${BUNDLE_DIR}`)
}

// ---------------------------------------------------------------------------------------- release

function findSigntool() {
  const kits = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin')
  if (!existsSync(kits)) return undefined
  const versions = readdirSync(kits).filter((d) => /^\d+\.\d+/.test(d)).sort().reverse()
  for (const v of versions) {
    const candidate = join(kits, v, 'x64', 'signtool.exe')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function installerFiles(version) {
  if (!existsSync(BUNDLE_DIR)) usage(`No installer folder at ${BUNDLE_DIR}`)
  const exe = readdirSync(BUNDLE_DIR).find((f) => f.endsWith('-setup.exe') && f.includes(`_${version}_`))
  if (!exe) usage(`No installer for ${version} in ${BUNDLE_DIR}`)
  const sig = `${exe}.sig`
  if (!existsSync(join(BUNDLE_DIR, sig))) usage(`No updater signature ${sig}: was the build signed?`)
  return { exe, sig }
}

async function release(args) {
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()
  if (dirty) usage('The working tree has uncommitted changes. Commit them first, so the release matches a commit.')

  const version = readConf().version
  await build({ ...args, debug: false })

  const { exe, sig } = installerFiles(version)
  if (args.unsigned) {
    console.log('\nUnsigned release: SmartScreen warns when the installer is run by hand. Updates from inside the app are not affected.')
  } else {
    const signtool = findSigntool()
    if (!signtool) usage('signtool.exe not found under Windows Kits; install the Windows SDK to verify the installer.')
    run(signtool, ['verify', '/pa', join(BUNDLE_DIR, exe)])
  }
  const notes = (args.notes ?? `Constellation ${version}`)
    + (args.unsigned ? '\n\nThis build is not code signed. Windows SmartScreen warns when the installer is run by hand; choose More info, then Run anyway. Updates from inside the app check the updater signature and are not affected.' : '')

  // The feed the app checks: tauri.conf.json plugins.updater.endpoints points at this file on the
  // latest release. The url must be the exact asset url `gh release create` will give the installer.
  const latest = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: {
      'windows-x86_64': {
        signature: readFileSync(join(BUNDLE_DIR, sig), 'utf8').trim(),
        url: `https://github.com/${RELEASES_REPO}/releases/download/v${version}/${encodeURIComponent(exe)}`,
      },
    },
  }
  mkdirSync(RELEASE_DIR, { recursive: true })
  const latestPath = join(RELEASE_DIR, 'latest.json')
  writeFileSync(latestPath, JSON.stringify(latest, null, 2) + '\n')
  console.log(`\nRelease files:\n  ${join(BUNDLE_DIR, exe)}\n  ${join(BUNDLE_DIR, sig)}\n  ${latestPath}`)

  if (args.dryRun) { console.log('\n--dry-run: nothing was published.'); return }

  const repo = spawnSync('gh', ['repo', 'view', RELEASES_REPO, '--json', 'visibility', '--jq', '.visibility'], { encoding: 'utf8' })
  if (repo.status !== 0) {
    usage(`The releases repo ${RELEASES_REPO} does not exist or gh is not signed in. Create it public and empty (the updater downloads from it without a token), then run this again.`)
  }
  if (repo.stdout.trim() !== 'PUBLIC') usage(`${RELEASES_REPO} is ${repo.stdout.trim()}; the updater needs it PUBLIC.`)

  run('gh', [
    'release', 'create', `v${version}`, '--repo', RELEASES_REPO, '--title', `Constellation ${version}`, '--notes', latest.notes,
    join(BUNDLE_DIR, exe), join(BUNDLE_DIR, sig), latestPath,
  ])
  console.log(`\nPublished https://github.com/${RELEASES_REPO}/releases/tag/v${version}`)
}

// ----------------------------------------------------------------------------------- version, test

function setVersion(next) {
  if (!/^\d+\.\d+\.\d+$/.test(next ?? '')) usage('version needs x.y.z')
  const conf = readConf()
  const previous = conf.version
  conf.version = next
  writeFileSync(CONF, JSON.stringify(conf, null, 2) + '\n')
  console.log(`tauri.conf.json: ${previous} -> ${next}`)
}

// cargo test compiles the shell but never packages it, so the sidecar and resources that prepare
// stages are left out of the config for it: a fresh clone runs the tests without prepare, node.exe,
// or a build of the dashboard. TAURI_CONFIG is merged into tauri.conf.json by tauri-build.
function test() {
  const env = { ...process.env, TAURI_CONFIG: JSON.stringify({ bundle: { externalBin: [], resources: [] } }) }
  run('cargo', ['test', '--manifest-path', join(SRC_TAURI, 'Cargo.toml')], { env })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  switch (args.command) {
    case 'prepare': return prepare(args)
    case 'dev': await prepare(args); return tauri(['dev'])
    case 'build': return build(args)
    case 'release': return release(args)
    case 'version': return setVersion(args.rest[0])
    case 'test': return test()
    default: return usage(args.command ? `Unknown command: ${args.command}` : undefined)
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err))
  process.exit(1)
})
