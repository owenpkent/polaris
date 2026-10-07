# Contributing to Polaris

Thanks for looking at the code. This page covers what you need to make a change and get it merged: how the tests are laid out, how the dashboard is styled, and how a visual change is checked. The product rules an agent must follow while editing this repo are in `CLAUDE.md`, and they apply to people too.

## Getting set up

Node 24 or newer. The server has no build step.

```sh
git clone https://github.com/owenpkent/polaris.git
cd polaris
npm install
npm --prefix command-center install
# npm install also turned on the pre-push hook (fast tests and build, see Gates below)
npm run mockup                        # the dashboard on a scratch database with demo data
```

Never run experiments against `command-center/data/`. Set `CC_DB` to a temp file, and `CC_BACKUP_DIR` and `CC_SECRETS_DIR` to scratch folders, because the daemon's backup job writes a copy at start.

## Code style

### TypeScript (`command-center/`)

- Node runs the source directly, so use erasable syntax only: no enums, namespaces, or constructor parameter properties.
- Relative imports end in `.ts`, and type-only imports use `import type`.
- All persistence goes through `Store` in `src/core`; never write SQL elsewhere. Schema changes are new append-only migrations in `schema.ts`.
- `src/invariants.test.ts` holds the safety rules as tests. If your change makes one fail, the change is wrong; do not edit the test to pass. Open an issue instead and say which rule you ran into. A new third-party source is added to `EXTERNAL_SOURCE_TYPES` in `src/core/types.ts`.

### React (`src/`)

- Every interactive control needs a 44px click target, a visible focus ring, and a keyboard path.
- Esc closes panels, drawers, menus, and dialogs. No drag-only interactions: anything a drag does, a menu or button does too.
- No hover-only actions: icon buttons are visible at rest and only brighten on hover.
- No emoji anywhere, not only in UI chrome: that covers docs, config, CLI output, commit messages, and generated files. Use lucide-react icons with `aria-hidden="true"` next to text, and an `aria-label` on icon-only buttons. The one exception is the fixtures under `command-center/src`, which keep emoji on purpose as coverage that third-party text passes through the pipeline unchanged.
- Colors come only from the tokens in `src/index.css`; no hex or rgba literals in JSX. For lucide icons, set `style={{ color: 'var(--x)' }}` rather than `color="var(--x)"`, because CSS variables in SVG attributes are unreliable.
- Dashboard data refreshes by polling `/api/events` (`src/command-center/useEvents.js`). A new view that shows server data calls `useEventRefresh`.
- No em dashes in docs or UI text.

### Offline (`src/command-center/offline*.js`, `outbox.js`)

The dashboard has to keep working when the server cannot be reached, so a new view or control has three things to get right:

- **Read through `api.js`.** Every GET it makes is stored and replayed offline for free. If a new tab reads an endpoint no other tab reads, add that call to `useMirrorWarm.js`, or the tab will be empty offline on a device that never opened it.
- **A control that writes takes `disabled` from `useOffline()`** (`offlineStatus.js`). The exception is the six task writes that `outbox.js` queues: create, update, complete, reopen, move, and comment. Do not add a queued write of any other kind without opening an issue first: the list is closed on the server too, and `src/invariants.test.ts` says so.
- **Leave recovery on.** Navigation, filters, Refresh, Retry, and the Connection form are never disabled offline. The Backups card under that form is not recovery: everything in it that writes is off, and a passphrase is never queued.

A unit test that touches `api.js` resets the copy and the queue in `beforeEach` with `setCacheBackend(memoryBackend())`, `setOutboxBackend(memoryBackend())`, and `resetOfflineStatus()`. A UI test goes offline with `page.context().setOffline(true)`, after waiting for the service worker to cache the page (see `goOffline` in `e2e/offline.spec.js`).

## Testing

```sh
npm run test:fast        # server tests, typecheck, dashboard unit tests (the pre-push hook and CI run this)
npm run test:ui          # builds, then Playwright UI tests at 1280px and 390px
npm run test:all         # both
npm test                 # dashboard unit tests only (Vitest + jsdom)
npm run test:desktop     # the desktop shell's Rust tests (cargo test)
npm run test:desktop:ui  # builds the debug desktop app and drives its real window (desktop/e2e)
(cd mobile && npm run apk)  # builds the Android app; needs a JDK and the Android SDK, see mobile/README.md
cd command-center && npm test && npm run typecheck
```

- **Server tests** use node:test and live next to the code as `*.test.ts`. A new module gets one. Use `openStore(':memory:')` or a temp folder, never `data/`, never the network, and nothing that depends on the machine: no real paths from your dev folder, and no real GitHub sign-in. Pass a token, a fake fetch, or `memorySecretStore()`.
- **Dashboard unit tests** use Vitest with jsdom and Testing Library (no jest-dom) and live next to the code as `*.test.js` or `*.test.jsx`. Vitest globals are off: import from `'vitest'` and call `cleanup()` in `afterEach`.
- **UI tests** live in `e2e/`. Every worker starts its own server on its own scratch database (`e2e/server.js`, through the fixture in `e2e/fixtures.js`), so tests run four at a time and share nothing. Import `test` and `expect` from `e2e/fixtures.js`, never from `@playwright/test`: the fixture freezes the browser clock to the moment the database was seeded, so due dates read the same on every run. Tag every `test.describe` with `@flow`, `@a11y`, or `@theme`; `e2e/conventions.test.js`, run by `npm test`, fails on a missing tag, the wrong import, or a class selector. Select by accessible name (`getByRole`), never by CSS class. A test that changes data creates its own task with `createTask` from `e2e/support.js`, and never asserts an exact count on the shared seeded project. Open a task panel with `openTask`, since the middle of a desktop row is an inline cell menu.
- **App-only code** (src/command-center/nativeApp.js, shareIntake.js, reminders.js and the Reminders card) is tested with Vitest; a test that needs the bridge installs a fake `window.Capacitor` (see `nativeApp.test.js`) and removes it afterwards. The shot states for the Android app (`e2e/shots.spec.js`) install a stand-in bridge with `page.addInitScript`. The Android project itself (`mobile/android`) has no automated tests: build the APK when `mobile/` changes.
- **Accessibility checks.** `e2e/axe.spec.js` runs axe-core over every view and open panel. A violation judged wrong or accepted goes in `e2e/axe-allow.json` with a reason, and an entry that matches nothing fails the run.
- **Browsers.** The UI tests run on installed Microsoft Edge. Set `CC_UI_BROWSER=chromium` to use Playwright's Chromium where Edge is missing (Linux), and `CC_UI_PORT` to move the block of worker ports off 8791 so two clones can run at once.
- **The desktop tests** need stable Rust with the MSVC toolchain (rustup plus the Visual Studio Build Tools C++ workload). They run on a fresh checkout: the test command leaves the staged node.exe and resources out of the config, so `prepare` is not needed.
- **The desktop UI tests** (`desktop/e2e`, `npm run test:desktop:ui`) run the real debug app, Windows only. The runner stages the server bundle (`prepare`), builds with `tauri build --debug --no-bundle` (no installer, no signing), then Playwright starts the exe with `--remote-debugging-port=0` set through `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, reads the port Chromium chose from the profile's `DevToolsActivePort` file, and attaches with `chromium.connectOverCDP`. Run them from a normal shell: an elevated WebView2 host ignores that variable (runtime 150 and later), so the CI job, which is elevated, asks for the port through the HKLM policy `Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments` instead, and `launchApp` refuses to start elevated without it. Every launch gets its own temp folder for `CC_DB`, `CC_SECRETS_DIR`, `CC_BACKUP_DIR`, `APPDATA`, and `LOCALAPPDATA` (WebView2's profile), and its own `CC_PORT`, never 8788, so the owner's real daemon and database are untouched; inherited `CC_*` variables are dropped, and only processes the tests started are ever killed. The app allows one copy per user, so close Constellation before running. They cover the cold start through the `#cc-url` handoff, reuse of a daemon that proves its token at `/api/identity`, refusal of an impostor, and the daemon stopping when the window closes. They live outside `e2e/` because that suite's fixtures (frozen clock, one server per worker, phone projects) do not fit a native window; the rules that do (role selectors, tagged describes, no exact counts) are kept. `--skip-build` reuses the last debug exe; arguments after `--` go to Playwright.
- **CI** (`.github/workflows/test.yml`) runs the fast layers on every push and pull request, and the UI tests and the vulnerability scan on pull requests into `main`; `desktop-ui.yml` runs the desktop UI tests on pull requests that touch the desktop shell. `weekly.yml` runs every UI project and the screenshot gallery against last week's baseline on Mondays.

Never push with `--no-verify` to get around a failing test.

## Gates

Every check that can stop a change, what triggers it, and what to do when it fails.

| Gate | Runs | When it fails |
| --- | --- | --- |
| Pre-push hook (`.githooks/pre-push`) | Before each `git push`: `npm run test:fast`, then `npm run build`, the same as the CI fast job. `npm install` turns it on. | Read the tail it prints (full log in `.git/pre-push.log`), fix the cause, push again. Never `--no-verify`. |
| `Tests` (`test.yml`) | Every pull request into `main`. One required check that needs every job below, the fast checks and the vulnerability scan included, and fails if any of them did not succeed. Nothing it needs is skipped on a pull request. | Open the job that is red in the run. A path-gated job (none yet) may be skipped only when `changes` says its paths were untouched. |
| Server tests, typecheck, dashboard unit tests, build | Every push and every pull request (a push to a branch with an open pull request runs it twice, so that `Tests` can require it). | Same as the hook: reproduce with `npm run test:fast` and `npm run build`. |
| UI tests in Edge, 4 parts | Pull requests into `main`. | Download the `playwright-output-N` artifact (traces and screenshots), or run `npm run test:ui`. |
| Server test coverage floor | Every push and pull request. `npm --prefix command-center run test:coverage` fails under the line, branch, or function floor in `command-center/package.json`. | Add tests for the code you changed. Raise the floors when coverage rises; never lower them to get green. |
| New vulnerabilities in this pull request (`osv` job in `test.yml`) | Pull requests into `main`: OSV-Scanner on the merge base and on the head, failing only on an advisory the pull request introduces. The result files are kept outside the checkout, so nothing in the tree can alter the comparison. | Update the package named in the log (Dependabot opens most of these). If there is no fix or it does not apply, say why in the pull request. |
| Vulnerabilities (`osv.yml`) | Mondays and on demand: a full scan that reports every known advisory without failing, until the findings that were in `main` when the gate was added are cleared. | Not a pull request check. Update the package named in the log. |
| Property tests (`command-center/src/**/*.property.test.ts`) | In the normal suite with a fixed seed. `nightly-properties.yml` runs them every night with a random seed and many more runs. | Fix the bug, then add the shrunk input from the log as a named regression test next to the code. Do not loosen the property. Replay with `CC_PROPERTY_SEED` and `CC_PROPERTY_PATH`. |
| Desktop UI tests (`desktop-ui.yml`) | Pull requests into `main` that touch `desktop/`, `scripts/desktop.mjs`, the identity route, or the workflow: builds the debug app on Windows and drives its real window (`desktop/e2e`). Not part of `Tests`. | Open the failed run. A launch that never opened its debugging port carries the app's log, output, and child processes in the error; a later failure attaches `desktop.log`, `daemon.log`, a screenshot, and a trace. |
| Weekly UI matrix (`weekly.yml`) | Mondays: every UI project, screenshots against last week's baseline, report-only timings. | Not a pull request check. Read the gallery artifact and fix what regressed. |
| Dependabot (`dependabot.yml`) | Weekly pull requests for npm, cargo, and GitHub Actions, minor and patch bumps grouped. | Review and merge like any pull request. There is no auto-merge. Gradle is left out because Capacitor pins the Android versions. |

Branch protection should require `Tests` and nothing else: it covers the fast checks, the coverage floor, the UI tests, and the pull request vulnerability scan. Until it does, the two older check names (`Server tests, typecheck, dashboard unit tests, build` and `UI tests in Edge at desktop and phone widths`) keep working.

## Visual system (`src/index.css`)

The dashboard is built from layers with crisp edges, so surfaces never blend together. The table below names each layer; the values differ per theme, the meanings do not.

| Layer | Token | Used for |
|-------|-------|----------|
| Recessed | `--bg-inset` | Inputs, Board lanes, progress tracks |
| Page | `--bg` | Page background |
| Raised | `--bg2` | Sheets, cards, list panels, top bar (`.surface`, `.card`) |
| Higher | `--bg3` | Task panel, menus, column header bar |
| Hover | `--bg-hover` | Hover on any row or item |

- **Contrast.** `--t1`, `--t2`, and `--t3` reach at least 4.5:1 on every layer (t1 and t2 reach 7:1 on the page), and `--bd-strong` reaches 3:1 for control edges. `--bd` is for dividers only. Measure any new color against every layer it can sit on before using it.
- **Depth.** Raised surfaces use `--shadow-1` (a lit top edge, a 1px dark ring, and a 1px drop: a resting panel sits on the page rather than floating over it); floating ones use `--shadow-pop`; recessed ones use `--shadow-inset`. Avoid soft glows and translucent blur.
- **Buttons.** `.btn` (raised, outlined), `.btn-primary`, `.btn-success` for positive confirms such as Accept, `.btn-danger`, `.btn-ghost`, and `.icon-btn` (44px square, add `is-danger` for delete). One filled button per toolbar (the main action); the rest are `.toolbar-btn`, quiet text buttons that take `is-active` while their setting is in effect. Menu items styled inline use `.hover-surface` for hover feedback.
- **Lists.** Task lists are flat: a hairline (`--bd`) under each row, `--bg-hover` on hover, no striping. The whole list is one `.surface` (`.mytasks-list`) with a flat column header stuck above it and a 48px header row per group (`.mytasks-section-header`: title, count) rather than a panel per group. The open row uses `--bg-selected` with a 3px blue left bar. `.is-striped` (`--bg-zebra`) remains for the Inbox table. Put `.flush-last` on a row container to drop the divider under its last row.
- **Projects.** A project is always shown with its colour: `projectColor(name)` in shared.jsx picks one of the accent tokens by the name, and `ProjectChip` (a dot and the name on a pill) or `ProjectAvatar` (a 28px tile with the initial) draws it. Nothing is stored.
- **Navigation.** `.nav-item` rows carry the view's icon (set on the item in App.jsx) and sit on a rounded pill inset from the column's edges; the open view is `--bg-selected` with a blue icon.
- **Tints.** Chips and banners use the `--*-soft` tokens with the matching solid color for text.
- **Motion.** Transitions are 0.15s on background, color, border, and shadow only, and `prefers-reduced-motion` turns them off.

**Light and dark.** Two themes: the dark one on `:root` and the light one in the `:root[data-theme='light']` block right after it. Those two blocks are the only place a color is named, so a component rule is written once and a new token has to be given a value in both. The light theme flips the depth model (recessed is darker than the page, raised goes toward white, hover darkens rather than lightens) and re-picks every accent rather than lightening it, since a pale accent that works on `#17191e` has no contrast left on white. Its tints are opaque, mixed into `--bg2`, so the accent text on a chip measures the same wherever the chip sits.

`src/theme.js` owns the choice (System, Light, or Dark; `useTheme` in `App.jsx`, the menu behind the top bar's Theme button) and writes the resolved theme to `data-theme` on `<html>`. System follows `prefers-color-scheme` and keeps following it while the tab is open. A copy of that resolution runs as a pre-paint script in `index.html` so a reload never flashes the wrong theme; if the storage key or the fallback changes in one, change it in the other. `npm run shots` takes every screenshot in both themes (it emulates the OS setting, which is what the default System choice follows), so a change is seen on light and dark without any extra step.

## Responsive

One breakpoint for the whole dashboard: phone is `max-width: 640px`. Static layout differences live in `src/index.css` under a media query on class names; layout computed in JavaScript (the My tasks grid template) uses `useNarrowBreakpoints` in `src/command-center/columnsState.js`, which exposes `phone` alongside the older 900 and 600 flags. No Tailwind breakpoint classes.

Above 640px the navigation is the sidebar in `src/Sidebar.jsx`, which lists every view and leaves the top bar without a menu button. Under 640px it is the tab bar in `src/BottomNav.jsx` (More opens the drawer), new tasks come from `src/command-center/NewTaskSheet.jsx` behind the floating New task button, and the dashboard installs from `public/manifest.webmanifest` (icons by `node scripts/icons.mjs`). Layout work is verified with screenshots, and they are one command.

## Screenshots

`npm run shots` builds the dashboard, starts the same scratch server the UI tests use, and photographs every view and its main states (the task panel, the task panel with a thread, the new task sheet, the due date and sort menus, the drawer, the inbox accept form) at 390 and 1280px in both themes: about 200 shots in about three minutes. The states are the tests in `e2e/shots.spec.js`; add one there when a new view, panel, sheet, or menu appears.

Files go under `.shots/` (ignored by git): `current/` for this run, `baseline/` for the last accepted look, `diff/` for the changed pixels, and `index.html`, a gallery with changed shots first. The run ends with a list of what changed since the baseline. Read each of those, at both widths and in both themes, fix what is wrong, and then `npm run shots -- --accept` to make the current shots the baseline. `--only mytasks,inbox` limits the run to some views and `--no-build` reuses the last build.

Baselines stay on the machine that made them, since text rendering differs from one machine to another. Text that changes from run to run without meaning anything is dealt with in the spec, in the smallest way that keeps the rest visible: the scratch backup folder's name and time on the Settings page are masked, and the digest's task and goal ids are rewritten to fixed placeholders on their way to the page, so a change to how the digest looks is still reported. A mask never covers a whole card, since everything under it would change unseen. Absolute dates, such as an overdue task's, change from one day to the next, so a shot that only differs in a date is accepted as is. `--window-size` cannot produce a phone width in headless Edge (it floors at about 504 CSS px); Playwright's viewport emulation has no such floor.

Every change to how the dashboard looks or lays out ends with this run, and the pull request names the shots that were checked under "Screenshots checked" in the template.

## Pull requests

1. Branch from `main` and keep the change focused: one feature or fix per pull request.
2. Run `npm run test:fast` always, `npm run test:ui` when the dashboard changed, and `npm run test:desktop` when `desktop/` changed.
3. New behavior has a test. A dashboard control has a UI test that finds it by its accessible name.
4. Use conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`. No co-author or generated-by trailers.
5. Fill in the template (`.github/pull_request_template.md`): what changed, which shots were checked, which tests ran.

Markdown in this repo uses ATX headers, tables for structured data, and fenced code blocks with language hints. Text files use LF line endings on every platform, set by `.gitattributes`.
