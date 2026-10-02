#!/usr/bin/env node
// Screenshots of every dashboard view and state, at 390 and 1280px, in both themes, in one command.
//
//   npm run shots                       build, shoot everything, report what changed
//   npm run shots -- --only mytasks,inbox   only those views (the names in e2e/shots.spec.js)
//   npm run shots -- --no-build         reuse dist/ from the last build
//   npm run shots -- --accept           make the current shots the new baseline
//   npm run shots -- --list             print the last run's summary again
//
// The shots come from e2e/shots.spec.js, run through Playwright's shots-* projects against the
// same scratch server the UI tests use, so nothing has to be started by hand and the real
// database is never opened. Files land under .shots/ (ignored by git):
//
//   current/   this run            baseline/  what the last accepted run looked like
//   diff/      changed pixels      status/    one JSON per shot     index.html  the gallery
//
// A shot with no baseline is "new" and becomes the baseline. One that differs is "changed": look
// at it in the gallery, fix the layout or accept it. Baselines stay on this machine because text
// rendering differs between machines.

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, '.shots')
const DIRS = {
  current: join(SHOTS, 'current'),
  baseline: join(SHOTS, 'baseline'),
  diff: join(SHOTS, 'diff'),
  status: join(SHOTS, 'status'),
}
const PROJECTS = ['shots-phone-dark', 'shots-phone-light', 'shots-desktop-dark', 'shots-desktop-light']
const VARIANTS = ['phone-dark', 'phone-light', 'desktop-dark', 'desktop-light']

function parseArgs(argv) {
  const args = { only: null, build: true, accept: false, list: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--only') args.only = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--no-build') args.build = false
    else if (a === '--accept') args.accept = true
    else if (a === '--list') args.list = true
    else {
      console.error(`Unknown option: ${a}\nUsage: npm run shots -- [--only view,view] [--no-build] [--accept] [--list]`)
      process.exit(2)
    }
  }
  return args
}

// The CLIs are run through node directly: no shell, so the -g regex below reaches Playwright as is.
const VITE = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
const PLAYWRIGHT = join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js')
function run(script, scriptArgs) {
  const result = spawnSync(process.execPath, [script, ...scriptArgs], { cwd: ROOT, stdio: 'inherit' })
  return result.status ?? 1
}

function readStatuses() {
  if (!existsSync(DIRS.status)) return []
  return readdirSync(DIRS.status)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(DIRS.status, f), 'utf8')))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function accept() {
  const statuses = readStatuses()
  let count = 0
  for (const s of statuses) {
    if (s.status !== 'changed') continue
    mkdirSync(DIRS.baseline, { recursive: true })
    copyFileSync(join(DIRS.current, `${s.name}.png`), join(DIRS.baseline, `${s.name}.png`))
    rmSync(join(DIRS.diff, `${s.name}.png`), { force: true })
    s.status = 'same'
    writeFileSync(join(DIRS.status, `${s.name}.json`), JSON.stringify(s))
    count++
  }
  console.log(count === 0 ? 'Nothing to accept: no shot is marked changed.' : `Accepted ${count} changed shot${count === 1 ? '' : 's'} as the new baseline.`)
  writeGallery(statuses)
}

function summarize(statuses, playwrightStatus) {
  const by = { new: [], changed: [], same: [] }
  for (const s of statuses) by[s.status]?.push(s)
  console.log('')
  console.log(`Shots: ${statuses.length}   same: ${by.same.length}   new: ${by.new.length}   changed: ${by.changed.length}`)
  if (by.new.length) {
    console.log('\nNew (now the baseline):')
    for (const s of by.new) console.log(`  ${s.name}`)
  }
  if (by.changed.length) {
    console.log('\nChanged since the baseline:')
    for (const s of by.changed) {
      console.log(`  ${s.name}`)
      console.log(`      current   ${join(DIRS.current, `${s.name}.png`)}`)
      console.log(`      baseline  ${join(DIRS.baseline, `${s.name}.png`)}`)
      if (existsSync(join(DIRS.diff, `${s.name}.png`))) console.log(`      diff      ${join(DIRS.diff, `${s.name}.png`)}`)
    }
    console.log('\nRead every changed shot. Then fix the layout, or `npm run shots -- --accept`.')
  }
  if (playwrightStatus) {
    console.log(`\nPlaywright exited with ${playwrightStatus}: at least one state could not be reached, so its shot is missing or stale. See .playwright/ for the trace.`)
  }
  console.log(`\nGallery: ${join(SHOTS, 'index.html')}`)
}

// A plain page for a person: every view as a row of its four variants, changed shots first with
// the baseline and the diff beside them. Dev tooling, not the dashboard, so it carries its own
// few styles.
function writeGallery(statuses) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const groups = new Map()
  for (const s of statuses) {
    const key = `${s.view}: ${s.state}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(s)
  }
  const rank = { changed: 0, new: 1, same: 2 }
  const ordered = [...groups.entries()].sort((a, b) => {
    const ra = Math.min(...a[1].map((s) => rank[s.status]))
    const rb = Math.min(...b[1].map((s) => rank[s.status]))
    return ra - rb || a[0].localeCompare(b[0])
  })
  const counts = { same: 0, new: 0, changed: 0 }
  for (const s of statuses) counts[s.status]++

  const cell = (s) => {
    const img = (dir, label) => `<figure><img src="${dir}/${esc(s.name)}.png" alt="${esc(label)} ${esc(s.name)}" loading="lazy"><figcaption>${esc(label)}</figcaption></figure>`
    const extra = s.status === 'changed'
      ? img('baseline', 'baseline') + (existsSync(join(DIRS.diff, `${s.name}.png`)) ? img('diff', 'diff') : '')
      : ''
    return `<div class="shot ${s.status}"><h3>${esc(s.variant)} <span class="tag">${esc(s.status)}</span></h3><div class="images">${img('current', 'current')}${extra}</div></div>`
  }
  const sections = ordered.map(([key, list]) => {
    const byVariant = VARIANTS.map((v) => list.find((s) => s.variant === v)).filter(Boolean)
    return `<section><h2>${esc(key)}</h2><div class="row">${byVariant.map(cell).join('')}</div></section>`
  })
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Dashboard shots</title>
<style>
  body { margin: 0; padding: 24px; font: 14px system-ui, sans-serif; background: #17191e; color: #f3f5f8; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .summary { color: #c2c9d3; margin-bottom: 24px; }
  section { margin-bottom: 32px; }
  h2 { font-size: 16px; margin: 0 0 10px; }
  .row { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
  .shot { background: #282c34; border: 1px solid #434955; border-radius: 8px; padding: 10px; }
  .shot.changed { border-color: #ff9189; }
  .shot.new { border-color: #80bcff; }
  h3 { font-size: 13px; font-weight: 600; margin: 0 0 8px; color: #c2c9d3; }
  .tag { margin-left: 6px; padding: 1px 8px; border-radius: 10px; background: #333842; font-weight: 500; }
  .changed .tag { background: #ff9189; color: #0b1220; }
  .new .tag { background: #80bcff; color: #0b1220; }
  .images { display: flex; gap: 10px; }
  figure { margin: 0; }
  figcaption { font-size: 12px; color: #aab2bd; margin-top: 4px; }
  img { display: block; max-height: 480px; width: auto; border: 1px solid #434955; background: #101216; }
</style></head><body>
<h1>Dashboard shots</h1>
<div class="summary">${statuses.length} shots: ${counts.same} same, ${counts.new} new, ${counts.changed} changed. Written by npm run shots on ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))}.</div>
${sections.join('\n')}
</body></html>
`
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(join(SHOTS, 'index.html'), html)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.accept) return accept()
  if (args.list) {
    const statuses = readStatuses()
    writeGallery(statuses)
    return summarize(statuses, 0)
  }

  if (args.build) {
    console.log('Building the dashboard')
    const status = run(VITE, ['build'])
    if (status !== 0) process.exit(status)
  }

  // A fresh run: the status and diff folders describe only the shots taken now.
  rmSync(DIRS.status, { recursive: true, force: true })
  rmSync(DIRS.diff, { recursive: true, force: true })
  if (!args.only) rmSync(DIRS.current, { recursive: true, force: true })

  const pwArgs = ['test', 'e2e/shots.spec.js', ...PROJECTS.flatMap((p) => ['--project', p]), '--reporter', 'dot']
  // Titles read "shots mytasks: list", so a view is matched at a word boundary before its colon.
  if (args.only) pwArgs.push('-g', `\\b(${args.only.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}): `)
  console.log(`Taking shots in ${PROJECTS.length} variants${args.only ? ` for ${args.only.join(', ')}` : ''}`)
  const status = run(PLAYWRIGHT, pwArgs)

  const statuses = readStatuses()
  writeGallery(statuses)
  summarize(statuses, status)
  process.exit(status === 0 ? 0 : 1)
}

main()
