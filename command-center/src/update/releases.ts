// Release tags and their notes (docs/update-proposal.md, sections 1B and 2). A release is a tag
// `v` + a strict MAJOR.MINOR.PATCH (version.ts): anything else is not a release and is never
// installed, shown, or compared. The notes are the tag's annotation, cleaned and capped before
// they are stored in the status file or shown anywhere.
//
// Nothing here runs a program or touches the filesystem, so any module may import it.
import { compareVersions, parseVersion, VERSION_RE } from './version.ts';

export const RELEASE_TAG_RE = /^v(\d+\.\d+\.\d+)$/;

/** Release notes are cut at this many characters. */
export const NOTES_MAX_LENGTH = 4000;

export interface ReleaseTag {
  /** The tag name, "v2.1.0". */
  tag: string;
  /** The version the tag names, "2.1.0". */
  version: string;
}

/** The version a release tag names, or null when the tag is not `v` + MAJOR.MINOR.PATCH. */
export function releaseTagVersion(tag: string): string | null {
  const m = RELEASE_TAG_RE.exec(tag);
  return m && VERSION_RE.test(m[1]) ? m[1] : null;
}

export function releaseTag(version: string): string {
  return `v${version}`;
}

/** The release tags among `tags`, newest version first. Everything else is dropped. */
export function releaseTags(tags: string[]): ReleaseTag[] {
  const found: ReleaseTag[] = [];
  for (const tag of tags) {
    const version = releaseTagVersion(tag.trim());
    if (version !== null) found.push({ tag: tag.trim(), version });
  }
  return found.sort((a, b) => compareVersions(parseVersion(b.version)!, parseVersion(a.version)!));
}

/** What `--to` accepts: "v2.1.0" or "2.1.0", giving "2.1.0"; anything else gives null. */
export function parseReleaseTarget(text: string): string | null {
  const bare = text.trim().replace(/^v/, '');
  return VERSION_RE.test(bare) ? bare : null;
}

/** The notes as they may be stored or shown: Windows line endings folded, every control character
 *  but tab and newline removed (so no terminal escape or hidden text gets through), surrounding
 *  whitespace trimmed, and the text cut at NOTES_MAX_LENGTH without splitting a surrogate pair. */
export function sanitizeNotes(text: string): string {
  let clean = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '').trim();
  if (clean.length > NOTES_MAX_LENGTH) {
    clean = clean.slice(0, NOTES_MAX_LENGTH);
    const last = clean.charCodeAt(clean.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) clean = clean.slice(0, -1);
  }
  return clean;
}
