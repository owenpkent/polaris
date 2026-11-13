# Polaris for Android

An Android shell around the dashboard, built with Capacitor. The app bundles the dashboard from `dist/` and talks to a Polaris server the owner names once in the connect form, the same as a browser would. Nothing runs on the phone except the dashboard: the server, the database, and every job stay where they are.

## Prerequisites

- An Android SDK at `%LOCALAPPDATA%\Android\Sdk` on Windows or `~/Android/Sdk` on Linux and macOS (or set `ANDROID_HOME`). Android Studio puts one there; so do the command-line tools alone, see "Without Android Studio" below.
- A JDK 21. `npm run apk` uses `JAVA_HOME` if it has `javac`, else the JDK bundled with Android Studio. A plain runtime (the Adoptium JRE that `java` on the PATH often is, and Debian's `openjdk-21-jre`) fails with "does not provide the required capabilities: [JAVA_COMPILER]" or "No JDK with javac found".
- The dashboard built: `npm run build` at the repo root.
- A server the phone can reach over HTTPS, with the app's origin allowed:

```
CC_CORS_ORIGINS=https://localhost
```

Inside the app the dashboard runs at `https://localhost`, so every request to the server is cross-origin and needs that entry. The server itself stays on loopback behind `tailscale serve` or a WireGuard tunnel, as command-center/README.md describes.

## Build

```sh
npm run build                       # repo root: dist/
cd mobile
npm install
npm run sync                        # copies dist/ into android/app/src/main/assets
npm run apk                         # android/app/build/outputs/apk/debug/app-debug.apk
```

`npm run open` opens the project in Android Studio for a device run or a signed build.

The app's version is the one in mobile/package.json, bumped with the root package.json at each release (docs/releases.md): `build.gradle` reads it for `versionName` and derives `versionCode` from it (MAJOR * 10000 + MINOR * 100 + PATCH), so nothing in the Android project is edited by hand for a release.

## Install on a phone

Either copy `app-debug.apk` to the phone and open it (allow installs from that source when asked), or with USB debugging on:

```sh
%LOCALAPPDATA%\Android\Sdk\platform-tools\adb install -r android\app\build\outputs\apk\debug\app-debug.apk
```

On first launch, type the server URL and connect. A server that takes the owner's Tailscale sign-in (`CC_TAILSCALE_LOGIN`, docs/tailscale-identity.md) needs nothing else, and the app stores no token; one that does not asks for the token from `command-center/data/api-token`, which the app then keeps. The app's requests are cross-origin (the page is `https://localhost`), so identity writes are accepted from that origin only because it is listed in `CC_CORS_ORIGINS` (docs/app-identity-proposal.md).

## Release build

`npm run apk` makes a debug APK signed with the SDK's debug key, for sideloading while developing. A release is signed with the OK Studio EV certificate on the SafeNet eToken, the key that signs the release tags (docs/releases.md, "Signing with the certificate"), so an installed release can only be replaced by an APK signed with that key, and the App update card in Settings (below) can offer the APK attached to the newest GitHub release.

With the token plugged in, from a normal (not elevated) terminal on Windows, at the repo root:

```sh
npm run release:apk                 # builds dist/, syncs, assembleRelease, signs, verifies
npm run release:apk -- --install    # and adb install -r on the one connected device
npm run release:apk -- --upload     # and attach it to the GitHub release for the tag
```

The script (mobile/scripts/release-apk.mjs) runs apksigner against the Windows certificate store, where the certificate's private key is the token's: the token asks for its PIN in its own dialog, once per session, and nothing reads a PIN, a password, or a keystore file. apksigner needs a Java with the store's provider (the `jdk.crypto.mscapi` module), which Android Studio's bundled runtime leaves out: an Adoptium JDK or JRE 21 on the PATH or in `JAVA_HOME` has it. Gradle keeps using the JDK `npm run apk` uses.

The signed file is `android/app/build/outputs/apk/release/polaris-X.Y.Z.apk`, with the version from package.json. Before it is kept, the script verifies it the way Android does (one signer, signature schemes v2 and v3) and checks that the signing certificate's public key is a pinned release signer in `release-signers`, a line an X.509 tag signature may verify against; an APK signed by any other certificate is removed. `--upload` runs only from a clean checkout of the tag `vX.Y.Z` and needs the GitHub release to exist (docs/releases.md, step 8); it attaches the file with `gh release upload --clobber`. It refuses `--skip-build`: `dist/` is not under git, so an APK for a release is always built from the checkout it is uploaded from.

Android lets an APK replace an installed app only when both carry the same signing key. The first release-signed install over a debug build is an uninstall (`adb uninstall com.okstudio.polaris`, or Uninstall on the phone) and then the install; from then on each release installs over the last one, from the App update card, a browser download, or adb.

CI (`.github/workflows/android.yml`, the release-build job) runs `assembleRelease` unsigned on pull requests that touch the app, so a change that breaks the release variant fails there and not at release time. Nothing in CI signs.

### When the certificate is renewed

A renewed certificate usually has a new key, and Android would refuse the next APK as a different signer. APK Signature Scheme v3 lets the old key vouch for the new one in a signing lineage, so an install signed by the old key still updates on Android 9 and later (an older device reinstalls). Every renewal adds one link to the lineage file `mobile/android/signing-lineage`, and the file must keep the whole chain: an install already updated to the second key needs that key in the proof of rotation. Run the commands with both certificates in the Windows store (an expired one still signs: Android ignores a certificate's dates), answering the token's PIN prompt for each key. Below, `apksigner` stands for `java -jar %LOCALAPPDATA%\Android\Sdk\build-tools\37.0.0\lib\apksigner.jar`.

First renewal (A to B). There is no lineage file yet, so the original certificate is the old signer:

```sh
apksigner rotate --out mobile\android\signing-lineage --old-signer --ks NONE --ks-type Windows-MY --ks-key-alias "OK Studio Inc." --ks-pass pass:windows-store --new-signer --ks NONE --ks-type Windows-MY --ks-key-alias "<alias of B>" --ks-pass pass:windows-store
```

Every later renewal (B to C, and so on). Do not repeat the first command: it would start a new A to C chain and overwrite the file that holds B. Read the existing lineage with `--in`, name its current leaf (the most recent certificate, B here, not the original) as the old signer, and write the extended chain back. Write to a new file and then replace the old one, so a failed run leaves the old lineage intact:

```sh
apksigner rotate --in mobile\android\signing-lineage --out mobile\android\signing-lineage.new --old-signer --ks NONE --ks-type Windows-MY --ks-key-alias "<alias of B>" --ks-pass pass:windows-store --new-signer --ks NONE --ks-type Windows-MY --ks-key-alias "<alias of C>" --ks-pass pass:windows-store
move /Y mobile\android\signing-lineage.new mobile\android\signing-lineage
```

Check the chain after each rotation. It must list every certificate, oldest first (A, B, then C):

```sh
apksigner lineage --in mobile\android\signing-lineage --print-certs
```

Commit `mobile/android/signing-lineage` (it holds public keys and the signatures that link them, nothing secret), add the new key's line to `release-signers` as docs/releases.md "Key rotation" describes, and append the new alias to `KEY_ALIASES` in mobile/scripts/release-apk.mjs, after the others. The alias is the certificate's friendly name in the store; `keytool -list -storetype Windows-MY` prints them. From then on every signing passes the lineage and two keys: the newest, which makes the signature installs are updated by, and the one the lineage starts from (A), which apksigner requires with a lineage and which makes the v2 signature for devices before Android 9. The middle keys do not sign; they are only in the lineage file. `--alias=` and `--old-alias=` override the two for one run. The original certificate stays in the store for that, and never signs on its own again. mobile/scripts/apkLineage.test.js rehearses both rotations (A to B, then B to C with `--in`) and the signing with three throwaway keys where a JDK and the build-tools exist.

## What the dashboard does differently inside the app

Both cases are keyed off `isNativeApp()` in src/command-center/nativeApp.js, which asks the `window.Capacitor` object the shell injects whether it is running on a native platform. The dashboard has no dependency on Capacitor.

- The default server URL is empty instead of the page's own origin, since the page's origin is the app itself.
- No service worker is registered: the app shell is inside the app, and the offline copy and the outbox live in the dashboard's own code and work as they do in a browser.
- The page runs edge to edge under the status bar and the gesture bar (Capacitor's SystemBars plugin with its default `insetsHandling: css`, and `viewport-fit=cover` in index.html). The dashboard pads for it in CSS: the top bar and what is stuck under it by `--safe-top` (`env(safe-area-inset-top)`, 0 in a browser), the bottom nav, the floating button, the sheets, and the navigation drawer by `env(safe-area-inset-bottom)` (`--safe-bottom`). The status bar's icons follow the dashboard's theme, not the phone's: `applyTheme` in src/theme.js calls `SystemBars.setStyle` through the bridge when it runs inside the app. While the soft keyboard is open the WebView is shortened by it, and the bottom nav and the floating button step aside (src/keyboard.js). docs/phone-keyboard-and-system-bars.md has how the insets depend on the WebView version, and why.
- The app is left out of Android device backups (allowBackup is off in the manifest), so the saved server URL, and the token when one was used, never leave the phone with a backup. A new phone means typing them again.

## Share sheet

Sharing text or a link from another app to Polaris opens the new-task sheet prefilled, for the owner to confirm or edit before it is saved. A second share while the sheet is open starts the draft again from the newer share. A share is the owner's own action, like pasting, so the task is created as the owner's trusted text: nothing goes to the inbox, and only `sourceUrl` carries the link.

How it travels: `AndroidManifest.xml` accepts `SEND` intents for `text/*`. `MainActivity.rewriteShare` reads the text and subject as `CharSequence` extras (styled text has no `String` form) and turns them into an `ACTION_VIEW` intent for `polaris://share?share-title=...&share-text=...`, which the Capacitor App plugin raises to the page as `appUrlOpen` (kept until the page listens, so a cold start works). `subscribeNativeShares` in src/command-center/nativeApp.js reads the same `share-*` parameters that the web app manifest's `share_target` uses, so the installed web app and the Android app share one intake (src/command-center/shareIntake.js).

## Reminders

Off until the owner turns them on in the Reminders card on the Settings page, which only appears inside the app. The dashboard then schedules one local notification per task with a due date, at the chosen time of day on the due date (or at the task's own time when the due date carries one), from its task list: on launch, on resume, whenever the server reports a change, whenever this device changes a task (offline and before any connection too, through src/command-center/taskChanges.js), and whenever the setting changes. Pending notifications are replaced each time, so a task that was completed or moved loses its reminder. Tapping one opens that task.

Everything happens on the phone through the Capacitor LocalNotifications plugin (`@capacitor/local-notifications`), called over the bridge by name from src/command-center/nativeApp.js. Nothing is sent to any push service, which is why the project rule about writes to external services does not apply. The plugin's own manifest declares `POST_NOTIFICATIONS` (asked for when the owner enables reminders) and `SCHEDULE_EXACT_ALARM`; reminders are scheduled inexact (`isExactNotification: false`, since the plugin defaults to exact) with `allowWhileIdle`, so they may arrive a few minutes late and never need the exact-alarm setting.

## App updates

The app keeps itself current, up to the one tap Android requires of an app that did not come from a store (docs/app-auto-update-proposal.md). The dashboard checks the public GitHub releases API on launch, on resume, and once an hour while the app is open, not more than every six hours unless Check now is pressed (src/command-center/appAutoUpdate.js, `AppUpdateScheduler.jsx`). A newer release with an APK is downloaded by the app shell's `AppUpdater` plugin (`AppUpdaterPlugin.java`) into `cache/updates`, from GitHub's https hosts only and only when its length matches what the release lists; the plugin then reads it as a package and refuses it unless it is `com.okstudio.polaris` signed by this app's certificate, or by a newer one the installed certificate vouches for through the signing lineage (When the certificate is renewed, above); several signers at once must match exactly. A verified download opens an "Update ready" dialog in the app (Later or Install; `AppUpdatePrompt.jsx`), and is also offered by a local notification ("Polaris 2.7.0 is ready to install") and an Install button on the App update card in Settings. Pressing Later asks for notification permission once (the first time only) and, when granted, keeps the notification in the tray as the reminder. Install hands the file to Android's installer through the app's FileProvider; Android asks once to allow Polaris to install apps (the install opens that page, from the dialog, the notification or the card alike) and confirms each install. When the owner comes back from that page the install continues by itself if it is now allowed; if not, the dialog returns with a line saying so. `REQUEST_INSTALL_PACKAGES` in the manifest is what lets that sheet open; no storage permission is needed, since the file stays in the app's cache.

The setting, Check for app updates automatically, is on by default and per device (localStorage `cc-app-update-v1`). Off means no check and no download. Nothing is installed silently, which Android does not allow a sideloaded app anyway, and nothing of this touches the server. The plugin's pure rules (which addresses are taken, what an asset name becomes on disk, which signers an archive may carry, and which flags read them on each Android version) are JVM unit tests under `app/src/test`, run with `gradlew testDebugUnitTest` (the Android release build job runs them in CI); the installer itself cannot be driven from a test.

## Testing

The tests are instrumented tests in `android/app/src/androidTest/java/com/okstudio/polaris`. They need an emulator (API 33 or later, so `POST_NOTIFICATIONS` exists; CI uses API 35 with Google APIs) that is already running. A physical phone is never picked automatically.

```sh
npm run test:android                  # repo root; same as npm --prefix mobile run test:device
npm run test:android -- --skip-build  # reuse dist/ from the last npm run build
npm run test:android -- -Pandroid.testInstrumentationRunnerArguments.class=com.okstudio.polaris.ShareRewriteTest
```

`scripts/test.mjs` builds the dashboard, runs `cap sync`, starts a scratch daemon on a free port (its own database, secret store, and backup folder in a temp directory, `CC_CORS_ORIGINS=https://localhost`), forwards the port with `adb reverse`, runs `connectedDebugAndroidTest`, and always removes the daemon, the forward, and the temp folder. It never touches `command-center/data` or a daemon on the default port. Reports land in `android/app/build/reports/androidTests/connected`. The forwarded port is plain http on the app's own loopback address, which Android blocks by default, so debug builds carry a network security config (`android/app/src/debug`) that allows cleartext to `127.0.0.1` and nothing else; release builds do not have it.

- `ShareRewriteTest` calls `MainActivity.rewriteShare` directly: String and styled (`Spanned`) extras, subject and text, empty or missing text, characters that need URL encoding, and intents that must be left alone. It needs no server.
- `AppEndToEndTest` drives the dashboard in the app's WebView against the scratch daemon: the connect form, a share opening the new-task sheet prefilled, a second share reseeding the open sheet, reminders being scheduled (and then cleared) as local notifications, and the task panel's subtask name box staying above the soft keyboard while four subtasks are typed (opened with a real touch so the keyboard shows, checked against `visualViewport` and the window's IME inset), the bottom nav stepping aside while the keyboard is up and coming back after Back, a phone row's long name wrapping in full (nothing cut sideways or by a line clamp) with its due date button under it on the name's left edge, 44px and opened by a real touch, and the "Moved <task> to No due date" toast keeping View and Undo inside the visual viewport, above the tab bar, and clear of the New task button, without taking focus, with View then focusing the task. `WebAppDriver` finds elements by role and accessible name through `evaluateJavascript` on the Capacitor bridge's WebView. `POST_NOTIFICATIONS` is granted with a `GrantPermissionRule`. Without the `serverUrl` and `apiToken` arguments the script passes, these tests are skipped.

CI runs the same command on an emulator for pull requests that touch `mobile/`, `src/`, `public/`, or the root `package.json` or lockfile (.github/workflows/android.yml). To start an emulator locally: `emulator -avd <name>`, and wait for it to boot.

### Without Android Studio

The command-line tools are enough to build and test, on Linux as on Windows. Download `commandlinetools-<os>-<build>_latest.zip` from the "Command line tools only" section of https://developer.android.com/studio, check its SHA-256 against the page, and unzip it so that `sdkmanager` sits at `<sdk>/cmdline-tools/latest/bin/`. Then install what CI uses and make the same emulator:

```sh
SDK=~/Android/Sdk    # %LOCALAPPDATA%\Android\Sdk on Windows
yes | $SDK/cmdline-tools/latest/bin/sdkmanager --licenses
$SDK/cmdline-tools/latest/bin/sdkmanager --install platform-tools "build-tools;37.0.0" "platforms;android-36" "platforms;android-35" emulator "system-images;android-35;google_apis;x86_64"
echo no | $SDK/cmdline-tools/latest/bin/avdmanager create avd -n test -k "system-images;android-35;google_apis;x86_64"
printf 'hw.cpu.ncore=4\nhw.ramSize=4096\n' >> ~/.android/avd/test.avd/config.ini
```

That is about 5 GB, and the first boot adds another 5 GB to the AVD. On Linux the emulator needs read and write access to `/dev/kvm`. A JDK that is not on the PATH is fine: point `JAVA_HOME` at it. Then, from the repo root:

```sh
$SDK/emulator/emulator -avd test -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect &
$SDK/platform-tools/adb wait-for-device
JAVA_HOME=/path/to/jdk-21 npm run test:android
$SDK/platform-tools/adb emu kill
```

The headless emulator boots in about half a minute; `adb shell getprop sys.boot_completed` prints `1` once it is ready.

## Icons

`assets/` holds the sources, copied from public/icons (`icon-only.png` for older launchers, `icon-foreground.png` for adaptive ones). The adaptive background is the colour in `android/app/src/main/res/values/ic_launcher_background.xml`, the dashboard's dark background. To regenerate after changing them:

```sh
npx @capacitor/assets generate --android --assetPath assets --iconBackgroundColor "#17191e" --iconBackgroundColorDark "#17191e"
```

Then put `android:drawable="@color/ic_launcher_background"` back on the `<background>` element in `res/mipmap-anydpi-v26/ic_launcher.xml` and `ic_launcher_round.xml`: the generator writes a reference to a background image it does not produce when given a colour.

## Layout

- `capacitor.config.json`: app id `com.okstudio.polaris`, web dir `../dist`.
- `android/`: the Gradle project Capacitor generated. Edit `android/app/src/main/AndroidManifest.xml` and `android/app/build.gradle` by hand when needed; `cap sync` does not overwrite them.
- Build output under `android/app/build/` and `android/.gradle/` is ignored.
