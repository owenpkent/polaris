// Run the dashboard against a scratch Command Center database with demo data, so the UI can be
// viewed without touching command-center/data. Ctrl+C stops both servers.
//
//   npm run mockup                  reuse the scratch database from the last run
//   npm run mockup -- --fresh       rebuild it from scratch
//   npm run mockup -- --port 8790   use another API port

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CC = join(ROOT, 'command-center')
const DATA_DIR = join(tmpdir(), 'constellation-mockup')
const DB_PATH = join(DATA_DIR, 'constellation.db')
const DASHBOARD_URL = 'http://localhost:5173'

function parseArgs(argv) {
  const args = { fresh: false, port: 8788 }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--fresh') args.fresh = true
    else if (argv[i] === '--port') args.port = Number(argv[++i])
    else {
      console.error(`Unknown option: ${argv[i]}\nUsage: npm run mockup -- [--fresh] [--port <number>]`)
      process.exit(2)
    }
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    console.error('--port needs a number between 1 and 65535')
    process.exit(2)
  }
  return args
}

/** Run one step to completion. A required step that fails ends the script. */
function run(command, commandArgs, { cwd, env, required = true, shell = false }) {
  const result = spawnSync(command, commandArgs, { cwd, env, stdio: 'inherit', shell })
  if (required && result.status !== 0) process.exit(result.status ?? 1)
}

function copyToClipboard(text) {
  for (const [command, ...commandArgs] of [['clip'], ['pbcopy'], ['xclip', '-selection', 'clipboard']]) {
    const result = spawnSync(command, commandArgs, { input: text })
    if (!result.error) return true
  }
  return false
}

// No shell on any platform: the URL carries `&` and `#`, which a shell would split or drop.
function openBrowser(url) {
  const [command, ...commandArgs] =
    process.platform === 'win32' ? ['rundll32', 'url.dll,FileProtocolHandler', url]
    : process.platform === 'darwin' ? ['open', url]
    : ['xdg-open', url]
  spawn(command, commandArgs, { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  // Its own backup folder. The secret store is shared with the real server on purpose, so the
  // mockup shows the real GitHub sign-in (command-center/README.md, GitHub setup). That also means
  // a backup passphrase set from the mockup's Backups card is the real one.
  const env = { ...process.env, CC_DB: DB_PATH, CC_BACKUP_DIR: join(dirname(DB_PATH), 'backups') }

  if (args.fresh) rmSync(DATA_DIR, { recursive: true, force: true })

  for (const folder of [ROOT, CC]) {
    if (!existsSync(join(folder, 'node_modules'))) {
      console.log(`Installing packages in ${folder}`)
      run('npm', ['install'], { cwd: folder, shell: true })
    }
  }

  if (!existsSync(DB_PATH)) {
    mkdirSync(DATA_DIR, { recursive: true })
    console.log('Importing projects and tasks into the scratch database')
    run(process.execPath, ['src/cli.ts', 'import'], { cwd: CC, env })
    console.log('Reading repo checklists from GitHub (skipped on failure)')
    run(process.execPath, ['src/cli.ts', 'sync', 'repo-files'], { cwd: CC, env, required: false })
    run(process.execPath, ['src/dev/seed-demo.ts'], { cwd: CC, env })
  }

  const children = []
  const stopAll = () => {
    for (const child of children) if (child.exitCode === null) child.kill()
  }
  process.on('SIGINT', stopAll)
  process.on('SIGTERM', stopAll)
  process.on('exit', stopAll)

  children.push(spawn(process.execPath, ['src/cli.ts', 'serve', '--port', String(args.port)], { cwd: CC, env, stdio: 'inherit' }))

  const tokenFile = join(DATA_DIR, 'api-token')
  for (let i = 0; i < 50 && !existsSync(tokenFile); i++) await sleep(100)
  if (!existsSync(tokenFile)) {
    console.error(`The server did not write ${tokenFile}. Is port ${args.port} already in use?`)
    stopAll()
    process.exit(1)
  }
  const token = readFileSync(tokenFile, 'utf8').trim()
  const serverUrl = `http://127.0.0.1:${args.port}`

  console.log()
  console.log(`Dashboard:  ${DASHBOARD_URL} (opens already connected)`)
  console.log(`Server URL: ${serverUrl}`)
  if (copyToClipboard(token)) console.log('API token also copied to the clipboard, in case the Connection page asks for it.')
  console.log('Press Ctrl+C to stop.')
  console.log()

  const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { cwd: ROOT, stdio: 'inherit' })
  children.push(vite)
  await sleep(2000)
  openBrowser(`${DASHBOARD_URL}/#${new URLSearchParams({ 'cc-url': serverUrl, 'cc-token': token })}`)

  vite.on('exit', (code) => {
    stopAll()
    process.exit(code ?? 0)
  })
}

main()
