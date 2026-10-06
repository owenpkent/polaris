// The version rule (docs/update-proposal.md, section 1B). A version is MAJOR.MINOR.PATCH with
// nothing before, after, or between: no "v", no prerelease, no build metadata. Anything else is
// not a version, and an updater that sees one installs nothing, shows nothing, and compares
// nothing. Comparison is by numeric tuple, so 2.10.0 is newer than 2.9.0.
//
// Nothing here runs a program or touches the filesystem, so any module may import it.

export const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export type VersionTuple = [number, number, number];

/** The three numbers of a well-formed version, or null for anything else. */
export function parseVersion(text: string): VersionTuple | null {
  const m = VERSION_RE.exec(text);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function isVersion(text: string): boolean {
  return parseVersion(text) !== null;
}

/** -1, 0, or 1 as `a` is older than, the same as, or newer than `b`. */
export function compareVersions(a: VersionTuple, b: VersionTuple): -1 | 0 | 1 {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

/** True only when both parse and `target` is strictly newer than `running`. A malformed version on
 *  either side is never newer: a mislabelled release must not install, and a mislabelled checkout
 *  must not be replaced by whatever happens to parse. */
export function isNewerVersion(target: string, running: string): boolean {
  const t = parseVersion(target);
  const r = parseVersion(running);
  return t !== null && r !== null && compareVersions(t, r) === 1;
}

/** The `version` field of a package.json's text, or null when the text is not JSON or has none. */
export function packageVersion(packageJsonText: string): string | null {
  try {
    const parsed: unknown = JSON.parse(packageJsonText);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const version = (parsed as { version?: unknown }).version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}
