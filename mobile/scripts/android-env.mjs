// Where the JDK and the Android SDK are, shared by apk.mjs and test.mjs. Gradle needs a JDK with a
// compiler, and the `java` on a Windows PATH is often a plain runtime (the Adoptium JRE here),
// which fails with "does not provide the required capabilities: [JAVA_COMPILER]". So this picks a
// JDK: JAVA_HOME if it has javac, else the JDK bundled with Android Studio. The SDK comes from
// ANDROID_HOME, ANDROID_SDK_ROOT, or Android Studio's default folder.
import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const androidDir = resolve(here, '..', 'android')
export const win = process.platform === 'win32'

function hasJavac(home) {
  return Boolean(home) && existsSync(join(home, 'bin', win ? 'javac.exe' : 'javac'))
}

export function findJdk() {
  if (hasJavac(process.env.JAVA_HOME)) return process.env.JAVA_HOME
  const candidates = win
    ? [join(process.env.ProgramFiles || 'C:\Program Files', 'Android', 'Android Studio', 'jbr')]
    : ['/Applications/Android Studio.app/Contents/jbr/Contents/Home', '/opt/android-studio/jbr']
  return candidates.find(hasJavac)
}

export function findSdk() {
  if (process.env.ANDROID_HOME) return process.env.ANDROID_HOME
  if (process.env.ANDROID_SDK_ROOT) return process.env.ANDROID_SDK_ROOT
  const home = process.env.LOCALAPPDATA || process.env.HOME || ''
  const candidate = join(home, 'Android', 'Sdk')
  return existsSync(candidate) ? candidate : undefined
}

/** The JDK and SDK, or an exit with the message that says what to install. */
export function requireToolchain() {
  const jdk = findJdk()
  if (!jdk) {
    console.error('No JDK with javac found. Set JAVA_HOME to a JDK 21, or install Android Studio.')
    process.exit(1)
  }
  const sdk = findSdk()
  if (!sdk) {
    console.error('No Android SDK found. Set ANDROID_HOME, or install one with Android Studio.')
    process.exit(1)
  }
  return { jdk, sdk }
}

export const gradlew = join(androidDir, win ? 'gradlew.bat' : 'gradlew')
