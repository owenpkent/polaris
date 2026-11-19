// The commands offline-check.mjs prints when it could not put the emulator's time back. Only the
// steps still in `problems` are listed, and automatic time goes back to the value it had before the
// run (deleted again when it had none), never to a value the run made up.
export function recoveryCommands({ serial, problems, autoTimeBefore, nowSeconds }) {
  const lines = []
  if (problems.has('auto_time')) {
    lines.push(
      autoTimeBefore === 'null' || autoTimeBefore === '' || autoTimeBefore === undefined
        ? `adb -s ${serial} shell settings delete global auto_time`
        : `adb -s ${serial} shell settings put global auto_time ${autoTimeBefore}`,
    )
  }
  if (problems.has('clock')) lines.push(`adb -s ${serial} shell date @${nowSeconds}`)
  return lines
}
