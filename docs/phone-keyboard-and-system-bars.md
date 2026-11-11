# The phone's system bars and keyboard

How the dashboard keeps clear of Android's status bar, navigation bar, and on-screen keyboard,
in the Android app and in a phone browser, and why. Written 2026-11-10 from research for two
fixes: the drawer's Settings row drawn under the navigation bar (PR #158), and the tab bar riding
on top of the keyboard (src/keyboard.js).

## Edge to edge in the Android app

The app (mobile/) uses Capacitor's SystemBars plugin with its default `insetsHandling: css`, and
index.html sets `viewport-fit=cover`. What the plugin then does depends on the phone's WebView
version (`initWindowInsetsListener` in `@capacitor/android`'s SystemBars.java, Capacitor 8.6):

- **WebView 140 or newer:** the page runs edge to edge, under the status bar and the navigation
  bar, and the WebView fills `env(safe-area-inset-*)` with their sizes. The page has to pad for
  them itself.
- **Older WebView:** the plugin pads the whole window natively by the bars, so the page never
  runs under them and every inset reads 0. Nothing on the page can be covered.

Capacitor also writes `--safe-area-inset-top`, `-right`, `-bottom`, and `-left` on `<html>`, for
WebViews whose `env()` values are wrong. Before WebView 144 the bottom inset is wrong while the
keyboard is up, so the plugin reports 0 for it then. The dashboard reads `env()` through two
tokens in src/index.css, `--safe-top` and `--safe-bottom` (added by PR #158), which are 0 in a
browser.

What pads for the bars:

- The top bar, and what is stuck under it: `--safe-top`.
- The tab bar, the New task button, the sheets, and the drawer: `env(safe-area-inset-bottom)` or
  `--safe-bottom`.

The drawer padded only its top until PR #158, so on a phone with a current WebView its last row,
Settings, sat under the navigation bar. A Samsung phone with three-button navigation shows it
worst, because that bar is about 48px tall against the gesture bar's 24px.

**Testing it.** An emulator's WebView can be older than 140, and then it shows the padded window,
not the edge-to-edge one. The API 36 `medium_phone_api` image behaved that way on 2026-11-10:
the drawer's Settings row showed whole there before the fix. A check that passes
there proves nothing about edge to edge. Read the version first:

```sh
adb shell dumpsys package com.google.android.webview | rg versionName
```

On an image with an older WebView, update "Android System WebView" from the Play Store, or check
on a phone.

## The on-screen keyboard

In the app, the plugin pads the window by the keyboard's height while it is up, so the WebView
gets shorter and everything fixed to its bottom (the tab bar and the New task button) rides up
onto the keyboard. On a 412px-wide phone the tab bar takes 64px of the roughly 400px left above
the keyboard, and none of its buttons are wanted while typing. In a phone browser the keyboard
shrinks the visual viewport instead, and the bar ends up behind the keyboard or over the field,
depending on the browser.

Options looked at:

- **`interactive-widget=resizes-content`** in the viewport meta makes Chrome on Android shrink the
  layout viewport, as the app already does. It decides how the page resizes, not what is shown,
  so on its own it does not move the bar out of the way. Safari does not support it.
- **The VirtualKeyboard API** (`navigator.virtualKeyboard.overlaysContent` and
  `env(keyboard-inset-height)`) lets a page lay the keyboard over itself and place things by its
  height. It is Chromium only, and in the app the window is already shrunk natively, so there is
  nothing for it to overlay.
- **Hide the bar while the keyboard is open.** This is the common pattern: Ionic's tab bar,
  FlutterFlow, and Median all offer it, and native Android apps commonly do it with the IME inset.
  The cost reported for it is flicker when focus moves between fields, which a short delay before
  the bar comes back prevents. The alternative, hiding the bar only on screens that take typing,
  does not fit a dashboard whose views nearly all do.

**What we do.** src/keyboard.js writes `data-keyboard="open"` on `<html>`, and under 640px
src/index.css hides the tab bar and the New task button then, and lets the Add task row being
typed in stop 16px above the keyboard instead of clearing the hidden bar. No browser reports the
keyboard directly, so it counts as open when both of these hold:

- A text field has focus (a text-like `<input>`, a `<textarea>`, or an editable region; not a
  checkbox, a date picker, or a read-only field).
- The visible height has dropped by at least 150px (a phone keyboard is 250px and more; an
  address bar coming and going is about 56px) below what it was with no field focused. The height
  is the visual viewport's times its pinch zoom, so zooming in does not count.

Either test alone gets it wrong. Focus alone would hide the bar for a hardware keyboard, or after
the keyboard is put away with Back while the field keeps focus. A short viewport alone would hide
it in split screen or a small desktop window, which is why the test is a drop from the height
before the field was focused, not a fraction of the screen: a window that is short to begin with
never drops. A first version compared with three quarters of the screen's height and hid the bar
in a short window and on a zoomed page (review of PR #159). The height to measure from is taken
again whenever no field has focus and the bar is showing, and when the window's width changes
(the phone turned), but not on a blur while the bar is hidden, which is usually focus moving to
the next field with the keyboard still up. The bar hides at once, and comes back 200ms after the keyboard closes, so
moving between fields does not flash it. The unit tests are in src/keyboard.test.js, and
`tabBarStepsAsideWhileTheKeyboardIsOpen` in the Android app's AppEndToEndTest checks it with a real
keyboard.

## Sources

- [Capacitor SystemBars docs](https://unpkg.com/@capacitor/core@8.5.2/system-bars.md)
- [Capacitor edge-to-edge and safe areas guide (Capawesome)](https://capawesome.io/blog/capacitor-edge-to-edge-and-safe-areas-guide/)
- [Android WebView and insets (Chromium)](https://chromium.googlesource.com/chromium/src/+/da170c2267b2201954efe1c8fa5d2d89ab09f7bf/android_webview/docs/insets.md)
- [The Virtual Keyboard API (Ahmad Shadeed)](https://ishadeed.com/article/virtual-keyboard-api/)
- [interactive-widget and the mobile keyboard](https://loke-dev-lokedevs-projects.vercel.app/blog/stop-using-dvh-interactive-widget-mobile-keyboard)
- [Ionic forum: hide the tab bar when the keyboard is open](https://forum.ionicframework.com/t/how-to-hide-the-tab-bar-when-keyboard-is-open/10723/2)
- [Median: keyboard state tracking](https://docs.median.co/docs/keyboard-state-tracking)
- [Hiding a bottom bar below the keyboard on Android](https://www.codegenes.net/blog/how-to-hide-the-bottomnavigationview-below-keyboard-with-adjustresize-set/)
- [Kotlin Slack: hiding the bottom bar when the keyboard opens](https://slack-chats.kotlinlang.org/t/507890/is-there-any-elegant-way-to-hide-the-bottombar-when-the-keyb)
