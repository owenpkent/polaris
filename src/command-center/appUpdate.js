// The "is there a newer app?" check, Android app only. Pure: no React, no bridge. The answer comes
// from GitHub's public releases API, asked only when the owner presses the button, with no
// credential. Polaris never installs anything itself: the owner opens the APK download.

export const RELEASES_API = 'https://api.github.com/repos/owenpkent/polaris/releases/latest'
export const RELEASES_PAGE = 'https://github.com/owenpkent/polaris/releases'

// 'X.Y.Z' to [major, minor, patch], else null.
export function parseVersion(text) {
  if (typeof text !== 'string') return null
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(text)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

// True only when both parse and `target` is strictly newer than `running`.
export function isNewerVersion(target, running) {
  const a = parseVersion(target)
  const b = parseVersion(running)
  if (!a || !b) return false
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

// From a GitHub release object: its version (no leading v; null for a draft, a prerelease, or a
// tag that is not a version) and its first .apk asset, if any.
export function pickApk(release) {
  if (!release || typeof release !== 'object') return { version: null, apk: null }
  const tag = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : ''
  const version = !release.draft && !release.prerelease && parseVersion(tag) ? tag : null
  const assets = Array.isArray(release.assets) ? release.assets : []
  const asset = assets.find(
    (a) => a && typeof a.name === 'string' && a.name.endsWith('.apk') && typeof a.browser_download_url === 'string',
  )
  const apk = asset
    ? { name: asset.name, url: asset.browser_download_url, size: typeof asset.size === 'number' ? asset.size : null }
    : null
  return { version, apk }
}

// Asks GitHub for the newest release. State: 'newer' (newer, with an APK), 'no-apk' (newer, none
// attached), 'current', or 'unknown' (the release has no version). Throws when GitHub does not answer.
export async function checkForAppUpdate(running, fetchImpl = fetch) {
  const res = await fetchImpl(RELEASES_API, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    credentials: 'omit',
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`GitHub did not answer (HTTP ${res.status}).`)
  const { version, apk } = pickApk(await res.json())
  if (!version) return { state: 'unknown', latest: null, apk }
  // An app whose own version is unknown is offered the newest release rather than told it is current.
  if (parseVersion(running) && !isNewerVersion(version, running)) return { state: 'current', latest: version, apk }
  return { state: apk ? 'newer' : 'no-apk', latest: version, apk }
}
