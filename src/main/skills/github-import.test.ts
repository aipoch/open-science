import { describe, expect, it } from 'vitest'

import {
  parseGitHubSkillUrl,
  parseGitHubRepo,
  fetchSkillFiles,
  scanRepoForSkills,
  type FetchLike
} from './github-import'

describe('parseGitHubSkillUrl', () => {
  it('parses tree URLs into owner/repo/ref/path', () => {
    expect(
      parseGitHubSkillUrl('https://github.com/acme/skills/tree/main/pack/citation-formatter')
    ).toEqual({ owner: 'acme', repo: 'skills', ref: 'main', path: 'pack/citation-formatter' })
  })

  it('trims a trailing SKILL.md from a blob URL', () => {
    expect(
      parseGitHubSkillUrl('https://github.com/acme/skills/blob/dev/pack/foo/SKILL.md')
    ).toEqual({ owner: 'acme', repo: 'skills', ref: 'dev', path: 'pack/foo' })
  })

  it('handles a bare repo URL and strips .git', () => {
    expect(parseGitHubSkillUrl('https://github.com/acme/skills.git')).toEqual({
      owner: 'acme',
      repo: 'skills',
      ref: undefined,
      path: ''
    })
  })

  it('keeps spaces in the path (literal and percent-encoded)', () => {
    expect(
      parseGitHubSkillUrl(
        'https://github.com/acme/skills/tree/main/scientific-skills/Academic Writing/citation-formatter'
      )?.path
    ).toBe('scientific-skills/Academic Writing/citation-formatter')
    expect(
      parseGitHubSkillUrl(
        'https://github.com/acme/skills/tree/main/scientific-skills/Academic%20Writing/citation-formatter'
      )?.path
    ).toBe('scientific-skills/Academic Writing/citation-formatter')
  })

  it('returns null for non-GitHub input', () => {
    expect(parseGitHubSkillUrl('https://example.com/foo')).toBeNull()
  })
})

// Builds a fake GitHub fetch: contents API returns a dir listing, download_urls return file bytes.
const fakeFetch = (files: Record<string, string>): FetchLike => {
  return async (url: string) => {
    if (url.includes('/contents/')) {
      const entries = Object.keys(files).map((name) => ({
        type: 'file',
        name,
        path: `pack/foo/${name}`,
        download_url: `https://raw/${name}`
      }))
      return {
        ok: true,
        status: 200,
        json: async () => entries,
        arrayBuffer: async () => new ArrayBuffer(0)
      }
    }
    const name = url.replace('https://raw/', '')
    const bytes = new TextEncoder().encode(files[name] ?? '')
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    }
  }
}

describe('fetchSkillFiles', () => {
  it('downloads files relative to the skill directory', async () => {
    const files = await fetchSkillFiles(
      { owner: 'acme', repo: 'skills', ref: 'main', path: 'pack/foo' },
      fakeFetch({ 'SKILL.md': '# Foo', 'run.py': 'print(1)' })
    )
    expect(files.map((file) => file.relativePath).sort()).toEqual(['SKILL.md', 'run.py'])
    expect(files.find((file) => file.relativePath === 'SKILL.md')?.content.toString()).toBe('# Foo')
  })

  it('rejects a directory without a SKILL.md', async () => {
    await expect(
      fetchSkillFiles(
        { owner: 'acme', repo: 'skills', ref: 'main', path: 'pack/foo' },
        fakeFetch({ 'readme.md': 'nope' })
      )
    ).rejects.toThrow(/No SKILL\.md/)
  })

  it('percent-encodes path segments in the contents URL', async () => {
    const urls: string[] = []
    const capturingFetch: FetchLike = async (url) => {
      urls.push(url)
      if (url.includes('/contents/')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              type: 'file',
              name: 'SKILL.md',
              path: 'Academic Writing/citation-formatter/SKILL.md',
              download_url: 'https://raw/SKILL.md'
            }
          ],
          arrayBuffer: async () => new ArrayBuffer(0)
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () => new TextEncoder().encode('# Foo').buffer
      }
    }

    await fetchSkillFiles(
      { owner: 'acme', repo: 'skills', ref: 'main', path: 'Academic Writing/citation-formatter' },
      capturingFetch
    )

    const contentsUrl = urls.find((url) => url.includes('/contents/'))
    expect(contentsUrl).toContain('Academic%20Writing')
    expect(contentsUrl).not.toContain('Academic Writing')
  })
})

export { fakeFetch }

describe('parseGitHubRepo', () => {
  it('parses owner/repo, owner/repo@ref, and URLs', () => {
    expect(parseGitHubRepo('acme/skills')).toEqual({
      owner: 'acme',
      repo: 'skills',
      ref: undefined
    })
    expect(parseGitHubRepo('acme/skills@dev')).toEqual({
      owner: 'acme',
      repo: 'skills',
      ref: 'dev'
    })
    expect(parseGitHubRepo('https://github.com/acme/skills/tree/main/x')).toEqual({
      owner: 'acme',
      repo: 'skills',
      ref: 'main'
    })
    expect(parseGitHubRepo('not a repo')).toBeNull()
  })
})

describe('scanRepoForSkills', () => {
  // Fakes the repo-meta + recursive git-tree API responses.
  const treeFetch = (
    paths: { path: string; type: string }[],
    defaultBranch = 'main'
  ): FetchLike => {
    return async (url: string) => {
      const body = url.includes('/git/trees/') ? { tree: paths } : { default_branch: defaultBranch }
      return {
        ok: true,
        status: 200,
        json: async () => body,
        arrayBuffer: async () => new ArrayBuffer(0)
      }
    }
  }

  it('finds every directory containing a SKILL.md and builds import URLs', async () => {
    const skills = await scanRepoForSkills(
      { owner: 'acme', repo: 'skills' },
      treeFetch([
        { path: 'README.md', type: 'blob' },
        { path: 'pack/foo/SKILL.md', type: 'blob' },
        { path: 'pack/foo/run.py', type: 'blob' },
        { path: 'bar/SKILL.md', type: 'blob' }
      ])
    )

    expect(skills).toEqual([
      {
        name: 'foo',
        path: 'pack/foo',
        url: 'https://github.com/acme/skills/tree/main/pack/foo'
      },
      { name: 'bar', path: 'bar', url: 'https://github.com/acme/skills/tree/main/bar' }
    ])
  })
})
