// Builds the debug APK. Gradle needs a JDK with a compiler, and the `java` on a Windows PATH is
// often a plain runtime (the Adoptium JRE here), which fails with "does not provide the required
// capabilities: [JAVA_COMPILER]". So this picks a JDK: JAVA_HOME if it has javac, else the JDK
// bundled with Android Studio. The SDK comes from ANDROID_HOME or Android Studio's default folder.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const androidDir = resolve(here, '..', 'android')
const win = process.platform === 'win32'

function hasJavac(home) {
  return Boolean(home) && existsSync(join(home, 'bin', win ? 'javac.exe' : 'javac'))
}

function findJdk() {
  if (hasJavac(process.env.JAVA_HOME)) return process.env.JAVA_HOME
  const candidates = win
    ? [join(process.env.ProgramFiles || 'C:\\Program Files', 'Android', 'Android Studio', 'jbr')]
    : ['/Applications/Android Studio.app/Contents/jbr/Contents/Home', '/opt/android-studio/jbr']
  return candidates.find(hasJavac)
}

function findSdk() {
  if (process.env.ANDROID_HOME) return process.env.ANDROID_HOME
  if (process.env.ANDROID_SDK_ROOT) return process.env.ANDROID_SDK_ROOT
  const home = process.env.LOCALAPPDATA || process.env.HOME || ''
  const candidate = win ? join(home, 'Android', 'Sdk') : join(home, 'Android', 'Sdk')
  return existsSync(candidate) ? candidate : undefined
}

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

const gradlew = join(androidDir, win ? 'gradlew.bat' : 'gradlew')
const args = process.argv.slice(2)
const task = args.length ? args : ['assembleDebug']
const result = spawnSync(gradlew, task, {
  cwd: androidDir,
  stdio: 'inherit',
  shell: win,
  env: { ...process.env, JAVA_HOME: jdk, ANDROID_HOME: sdk },
})
if (result.status === 0 && task[0] === 'assembleDebug') {
  console.log(`APK: ${join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')}`)
}
process.exit(result.status ?? 1)
