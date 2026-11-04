# The Android app updates itself, up to the one tap Android requires

Status: built 2026-11-04 (feat/app-auto-update), as described here.

## Where things stand

A release carries a signed APK (docs/releases.md step 8), and the App update card on Settings, inside the app only, asks GitHub's public releases API for the newest release when the owner presses its button and offers that APK as a browser download (src/command-center/appUpdate.js, AppUpdateSettings.jsx). Nothing checks on its own, nothing downloads, and the install is a trip through the browser's download list.

Android does not let an app that was sideloaded replace itself without the owner: only a device-owner app or an app store can. What it allows is for the app to fetch the new APK and hand it to the system installer, which shows one confirmation sheet. That tap is the floor, and this change takes the app down to it.

## What changes

### The check runs by itself

A new module, src/command-center/appAutoUpdate.js, owns the schedule and the flow. `AppUpdateScheduler.jsx`, mounted next to `ReminderScheduler.jsx` and like it rendered only when `isNativeApp()`, runs a check on mount, on App resume (`subscribeAppResume` in nativeApp.js), and once an hour while the app is open, and the module decides whether a check is due: not more often than every six hours unless the owner presses Check now. The check is `checkForAppUpdate` from appUpdate.js, unchanged: the latest release, its version, its first APK asset.

Per-device preferences live in localStorage under `cc-app-update-v1`, shape `{ enabled, lastCheckedAt, ready, lastError }`, with `enabled` true by default (the app is the owner's and a stale app is the failure here, the opposite of reminders, which can disturb), and a `cc-app-update-changed` window event on every save, the reminders pattern.

### The app downloads and checks the APK

A newer release with an APK is downloaded by the app shell, not the page: the asset URL redirects to another GitHub host and the page's origin is `https://localhost`, so a native fetch is the one that works, and the file has to land somewhere the system installer can read. A new Capacitor plugin, `AppUpdater` (mobile/android/app/src/main/java/com/okstudio/polaris/AppUpdaterPlugin.java, registered in MainActivity before `super.onCreate`), has these methods, all reached from the dashboard through `nativeCall` and nothing else:

- `download({ url, name, size })`: an https URL on github.com or a githubusercontent.com host, or it is refused. Downloads on a background thread to `cache/updates/<name>` (the name is reduced to a plain file name), replacing whatever was there, follows GitHub's redirects, and refuses a file whose length differs from `size` when one is given. Returns `{ path, size }`.
- `verify({ path })`: reads the file as a package and returns `{ ok, packageName, versionName, versionCode, sameSigner }`. `ok` is true only when the package name is this app's and the signer is this app's: the eToken certificate that signed the release tag and the APK, or a newer certificate the installed one vouches for through the signing lineage (mobile/README.md, When the certificate is renewed), which is the rotation Android itself accepts. Several signers at once must match exactly. On Android 9 and 10 the archive is read with both signing flags, since those versions collect an archive's certificates only for the older one. Anything else is deleted and refused. Android would refuse the install anyway; checking first keeps a bad file from ever reaching the installer and gives the owner a reason instead of a system error.
- `canInstall()`: `{ allowed }`, whether Android lets this app start an install (`canRequestPackageInstalls`, always true before Android 8). `openInstallSettings()` opens the system page where the owner allows it, once.
- `install({ path })`: hands the file to the system installer through the existing FileProvider (`cache-path` in res/xml/file_paths.xml already covers the cache directory) as `application/vnd.android.package-archive`, with read permission granted to the installer. Android shows its confirmation; the app does nothing else. The new version starts fresh and finds the same localStorage.
- `discard()`: deletes `cache/updates`.

The manifest gains `REQUEST_INSTALL_PACKAGES`, which is what lets the installer sheet open. No storage permission: the file stays in the app's own cache.

### What the owner sees

- A notification, scheduled through the LocalNotifications plugin the app already has, when a download has been checked: "Polaris 2.7.0 is ready to install", with the line that Android will ask once. Tapping it calls `install`. It carries `extra: { kind: 'app-update' }`, and the reminders' tap handler leaves it to the update module.
- The App update card on Settings becomes: a checkbox "Check for app updates automatically" (on by default), "Last checked" with the result ("You have the newest version", "2.7.0 is ready to install", "v2.7.0 has no APK attached yet" while a release waits for its APK, or the error), an Install button when one is ready, Check now, and the Releases page link. Install asks `canInstall` first and, when Android has not yet allowed it, says so and opens the system page.
- Nothing else. The dashboard in a browser shows none of it, as today.

### What this does not do

- No silent install: impossible for a sideloaded app, and not attempted.
- No server part, no MCP tool, no outbox op kind, no rule action, no event: the server does not know the app updated. The check is the public releases API with no credential, as today.
- No download when the setting is off, and no download of a release whose APK is missing or whose version is not newer.
- No change to how releases are made or signed.

## What this trusts

The same things as today's card, with one more check. The release is trusted because the tag is signed with a pinned key and the APK with the same certificate (docs/releases.md). The download comes from the URL GitHub's API returned for the latest release, over https, from GitHub's hosts only. Before the installer sees the file, `verify` confirms it is this app, signed by this app's certificate; Android enforces the same rule at install. GitHub's API answer is data: a release with no version, a prerelease, a draft, or an asset that is not an APK is ignored, as today.

## Tests

- src/command-center/appAutoUpdate.test.js: the due rule (first run, six hours, Check now), and the flow with a fake bridge and fake fetch: newer with APK downloads, verifies, notifies, and records `ready`; a verify that fails records the error, discards, and never installs; current clears `ready` and discards; the setting off does nothing; an install when Android has not allowed it opens the settings page instead.
- src/command-center/AppUpdateSettings.test.jsx: the card's states and buttons against a mocked module.
- src/command-center/nativeApp.test.js (if present) or appAutoUpdate.test.js: each wrapper names the right plugin and method.
- e2e/shots.spec.js: the `settings: app update` state's Capacitor stub answers the AppUpdater methods, so the shot shows the card with a version ready to install.
- mobile: the plugin's URL and file-name rules are unit-testable without a device only if factored into static methods, which they are (`AppUpdaterPlugin.isAllowedUrl`, `safeFileName`), tested next to `ShareRewriteTest`. The instrumented suite is unchanged; the system installer cannot be driven from it.

## Size

One pull request: the plugin (about two hundred lines of Java), the dashboard module and card (about three hundred lines with tests), a manifest line, docs here and in mobile/README.md and the CLAUDE.md Android bullet, and the shots state. The owner gets it with the next release's APK, installed once more by hand; from then on the app offers each release itself.
