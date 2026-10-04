# Polaris for Android

An Android shell around the dashboard, built with Capacitor. The app bundles the dashboard from `dist/` and talks to a Polaris server the owner names once in the connect form, the same as a browser would. Nothing runs on the phone except the dashboard: the server, the database, and every job stay where they are.

## Prerequisites

- Android Studio with an SDK at `%LOCALAPPDATA%\Android\Sdk` (or set `ANDROID_HOME`).
- A JDK 21. `npm run apk` uses `JAVA_HOME` if it has `javac`, else the JDK bundled with Android Studio. A plain runtime (the Adoptium JRE that `java` on the PATH often is) fails with "does not provide the required capabilities: [JAVA_COMPILER]".
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

## Install on a phone

Either copy `app-debug.apk` to the phone and open it (allow installs from that source when asked), or with USB debugging on:

```sh
%LOCALAPPDATA%\Android\Sdk\platform-tools\adb install -r android\app\build\outputs\apk\debug\app-debug.apk
```

On first launch, type the server URL and paste the token from `command-center/data/api-token`. The app keeps them.

## What the dashboard does differently inside the app

Both cases are keyed off `isNativeApp()` in src/command-center/nativeApp.js, which checks for the `window.Capacitor` object the shell injects. The dashboard has no dependency on Capacitor.

- The default server URL is empty instead of the page's own origin, since the page's origin is the app itself.
- No service worker is registered: the app shell is inside the app, and the offline copy and the outbox live in the dashboard's own code and work as they do in a browser.

## Share sheet

Sharing text or a link from another app to Polaris opens the new-task sheet prefilled, for the owner to confirm or edit before it is saved. A share is the owner's own action, like pasting, so the task is created as the owner's trusted text: nothing goes to the inbox, and only `sourceUrl` carries the link.

How it travels: `AndroidManifest.xml` accepts `SEND` intents for `text/*`. `MainActivity.rewriteShare` turns one into an `ACTION_VIEW` intent for `polaris://share?share-title=...&share-text=...`, which the Capacitor App plugin raises to the page as `appUrlOpen` (kept until the page listens, so a cold start works). `subscribeNativeShares` in src/command-center/nativeApp.js reads the same `share-*` parameters that the web app manifest's `share_target` uses, so the installed web app and the Android app share one intake (src/command-center/shareIntake.js).

## Reminders

Off until the owner turns them on in the Reminders card on the Settings page, which only appears inside the app. The dashboard then schedules one local notification per task with a due date, at the chosen time of day on the due date (or at the task's own time when the due date carries one), from its task list: on launch, on resume, whenever the server reports a change, and whenever the setting changes. Pending notifications are replaced each time, so a task that was completed or moved loses its reminder. Tapping one opens that task.

Everything happens on the phone through the Capacitor LocalNotifications plugin (`@capacitor/local-notifications`), called over the bridge by name from src/command-center/nativeApp.js. Nothing is sent to any push service, which is why the project rule about writes to external services does not apply. The plugin's own manifest declares `POST_NOTIFICATIONS` (asked for when the owner enables reminders) and `SCHEDULE_EXACT_ALARM`; reminders are scheduled inexact with `allowWhileIdle`, so they may arrive a few minutes late and never need the exact-alarm setting.

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
