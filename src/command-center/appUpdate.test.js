import { describe, test, expect, vi } from 'vitest'
import {
  RELEASES_API, parseVersion, isNewerVersion, pickApk, checkForAppUpdate,
} from './appUpdate'

const APK = {
  name: 'polaris-2.4.0.apk',
  browser_download_url: 'https://github.com/owenpkent/polaris/releases/download/v2.4.0/polaris-2.4.0.apk',
  size: 4348073,
}

function release(over = {}) {
  return { tag_name: 'v2.4.0', draft: false, prerelease: false, assets: [APK], ...over }
}

function fakeFetch(body, status = 200) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }))
}

describe('parseVersion', () => {
  test('reads three numbers and nothing else', () => {
    expect(parseVersion('2.3.10')).toEqual([2, 3, 10])
    expect(parseVersion('v2.3.0')).toBeNull()
    expect(parseVersion('2.3')).toBeNull()
    expect(parseVersion('2.3.0-rc1')).toBeNull()
    expect(parseVersion(' 2.3.0')).toBeNull()
    expect(parseVersion(null)).toBeNull()
  })
})

describe('isNewerVersion', () => {
  test('compares numerically and strictly', () => {
    expect(isNewerVersion('2.4.0', '2.3.0')).toBe(true)
    expect(isNewerVersion('2.10.0', '2.9.0')).toBe(true)
    expect(isNewerVersion('3.0.0', '2.9.9')).toBe(true)
    expect(isNewerVersion('2.3.0', '2.3.0')).toBe(false)
    expect(isNewerVersion('2.2.9', '2.3.0')).toBe(false)
  })

  test('is false when either side is not a version', () => {
    expect(isNewerVersion('2.4.0', null)).toBe(false)
    expect(isNewerVersion('latest', '2.3.0')).toBe(false)
  })
})

describe('pickApk', () => {
  test('returns the version and the first apk asset', () => {
    const other = { name: 'notes.txt', browser_download_url: 'https://x.test/notes.txt', size: 1 }
    expect(pickApk(release({ assets: [other, APK] }))).toEqual({
      version: '2.4.0',
      apk: { name: 'polaris-2.4.0.apk', url: APK.browser_download_url, size: 4348073 },
    })
  })

  test('has no apk when none is attached', () => {
    expect(pickApk(release({ assets: [] }))).toEqual({ version: '2.4.0', apk: null })
    expect(pickApk(release({ assets: undefined }))).toEqual({ version: '2.4.0', apk: null })
  })

  test('a draft, a prerelease, or a tag that is not a version has no version', () => {
    expect(pickApk(release({ draft: true })).version).toBeNull()
    expect(pickApk(release({ prerelease: true })).version).toBeNull()
    expect(pickApk(release({ tag_name: 'nightly' })).version).toBeNull()
    expect(pickApk(release({ tag_name: undefined })).version).toBeNull()
  })

  test('tolerates garbage', () => {
    expect(pickApk(null)).toEqual({ version: null, apk: null })
    expect(pickApk('x')).toEqual({ version: null, apk: null })
    expect(pickApk({ assets: [null, 5, { name: 7 }] })).toEqual({ version: null, apk: null })
  })
})

describe('checkForAppUpdate', () => {
  test('asks GitHub without credentials or a cached answer', async () => {
    const f = fakeFetch(release())
    await checkForAppUpdate('2.3.0', f)
    expect(f).toHaveBeenCalledWith(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      credentials: 'omit',
      cache: 'no-store',
    })
  })

  test('newer with an apk', async () => {
    const res = await checkForAppUpdate('2.3.0', fakeFetch(release()))
    expect(res.state).toBe('newer')
    expect(res.latest).toBe('2.4.0')
    expect(res.apk.name).toBe('polaris-2.4.0.apk')
  })

  test('newer without an apk', async () => {
    const res = await checkForAppUpdate('2.3.0', fakeFetch(release({ assets: [] })))
    expect(res).toEqual({ state: 'no-apk', latest: '2.4.0', apk: null })
  })

  test('an app whose own version is unknown is offered the newest release', async () => {
    expect((await checkForAppUpdate(null, fakeFetch(release()))).state).toBe('newer')
    expect((await checkForAppUpdate('', fakeFetch(release({ assets: [] })))).state).toBe('no-apk')
  })

  test('current when not newer', async () => {
    expect((await checkForAppUpdate('2.4.0', fakeFetch(release()))).state).toBe('current')
    expect((await checkForAppUpdate('2.5.0', fakeFetch(release()))).state).toBe('current')
  })

  test('unknown when the release has no version', async () => {
    const res = await checkForAppUpdate('2.3.0', fakeFetch(release({ tag_name: 'nightly' })))
    expect(res.state).toBe('unknown')
    expect(res.latest).toBeNull()
  })

  test('throws when GitHub does not answer', async () => {
    await expect(checkForAppUpdate('2.3.0', fakeFetch({}, 403))).rejects.toThrow('GitHub did not answer (HTTP 403).')
  })
})
