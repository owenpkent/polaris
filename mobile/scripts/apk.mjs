// Builds the debug APK. The JDK and SDK lookup is in android-env.mjs.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { androidDir, gradlew, requireToolchain, win } from './android-env.mjs'

const { jdk, sdk } = requireToolchain()
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
