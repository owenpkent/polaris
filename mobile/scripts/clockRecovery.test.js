import { describe, expect, it } from 'vitest'
import { recoveryCommands } from './clockRecovery.mjs'

const serial = 'emulator-5554'
const nowSeconds = 1800000000

describe('recoveryCommands', () => {
  it('puts manual time (0) back, not 1, when both steps failed', () => {
    const lines = recoveryCommands({ serial, problems: new Set(['clock', 'auto_time']), autoTimeBefore: '0', nowSeconds })
    expect(lines).toEqual([
      'adb -s emulator-5554 shell settings put global auto_time 0',
      'adb -s emulator-5554 shell date @1800000000',
    ])
  })

  it('leaves a restored automatic time alone when only the clock failed', () => {
    const lines = recoveryCommands({ serial, problems: new Set(['clock']), autoTimeBefore: '0', nowSeconds })
    expect(lines).toEqual(['adb -s emulator-5554 shell date @1800000000'])
  })

  it('prints only the automatic time step when only that failed', () => {
    const lines = recoveryCommands({ serial, problems: new Set(['auto_time']), autoTimeBefore: '1', nowSeconds })
    expect(lines).toEqual(['adb -s emulator-5554 shell settings put global auto_time 1'])
  })

  it('deletes the setting again when the emulator had none', () => {
    for (const autoTimeBefore of ['null', '', undefined]) {
      const lines = recoveryCommands({ serial, problems: new Set(['auto_time']), autoTimeBefore, nowSeconds })
      expect(lines).toEqual(['adb -s emulator-5554 shell settings delete global auto_time'])
    }
  })
})
