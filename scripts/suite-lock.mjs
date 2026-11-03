// Run a command under the machine-wide UI suite lock (e2e/suiteLock.js), so a build that
// replaces dist/ never runs under another suite that is serving it. The words after the script
// are joined and run by the shell, so package.json can write
//
//   node scripts/suite-lock.mjs vite build "&&" playwright test --project desktop
//
// and arguments given to `npm run test:ui -- ...` land at the end, on the playwright command.
// The command gets the lock's token in CC_UI_SUITE_LOCK, so its Playwright run goes on under this
// lock instead of waiting for it.
import { spawn } from 'node:child_process'
import { acquireSuiteLock, TOKEN_ENV } from '../e2e/suiteLock.js'

const command = process.argv.slice(2).join(' ').trim()
if (!command) {
  console.error('Usage: node scripts/suite-lock.mjs <command...>')
  process.exit(2)
}

const lock = await acquireSuiteLock({ command })
const child = spawn(command, { shell: true, stdio: 'inherit', env: { ...process.env, [TOKEN_ENV]: lock.token } })
// Ctrl+C reaches the child too; this process waits for it to finish before letting the lock go.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {})
child.on('exit', (code, signal) => {
  lock.release()
  process.exit(code ?? (signal ? 1 : 0))
})
