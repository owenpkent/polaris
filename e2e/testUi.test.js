// @vitest-environment node
import { describe, expect, test } from 'vitest'
import { PROJECTS, playwrightArgs } from '../scripts/test-ui.mjs'

describe('scripts/test-ui.mjs argument list', () => {
  test('starts with test and one --project per project', () => {
    const args = playwrightArgs()
    expect(args[0]).toBe('test')
    expect(PROJECTS).toHaveLength(7)
    expect(args.slice(1)).toEqual(PROJECTS.flatMap((p) => ['--project', p]))
  })

  test('a multiword --grep value arrives as one argument', () => {
    const args = playwrightArgs(['--grep', 'context menu'])
    expect(args.slice(-2)).toEqual(['--grep', 'context menu'])
  })

  test('an alternation regex is not split or piped', () => {
    const args = playwrightArgs(['-g', 'Board|Digest'])
    expect(args.slice(-2)).toEqual(['-g', 'Board|Digest'])
  })

  test('a shard flag passes through', () => {
    expect(playwrightArgs(['--shard=3/12']).at(-1)).toBe('--shard=3/12')
  })
})
