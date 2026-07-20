import { describe, expect, it } from 'vitest'

import { SKILL_IMPORT_LIMITS } from './import-limits'
import {
  parseGitHubSkillUrl,
  parseGitHubRepo,
  fetchSkillFiles,
  scanRepoForSkills,
  type FetchLike
} from './github-import'

// Per-file / total caps the download guards enforce; tests derive sizes from these so they track the
// configured limits instead of hard-coded numbers.
const OVER_FILE = SKILL_IMPORT_LIMITS.maxFileBytes + 1
const AT_FILE = SKILL_IMPORT_LIMITS.maxFileBytes

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

  it('rejects a file larger than the per-file limit (post-download guard)', async () => {
    // A body one byte over the per-file cap with no Content-Length header falls through to the
    // post-download size guard.
    const oversized: FetchLike = async (url) => {
      if (url.includes('/contents/')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              type: 'file',
              name: 'SKILL.md',
              path: 'pack/foo/SKILL.md',
              download_url: 'https://raw/big'
            }
          ],
          arrayBuffer: async () => new ArrayBuffer(0)
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () => new ArrayBuffer(OVER_FILE)
      }
    }

    await expect(
      fetchSkillFiles({ owner: 'acme', repo: 'skills', ref: 'main', path: 'pack/foo' }, oversized)
    ).rejects.toThrow(/exceeds the .* limit/)
  })

  it('rejects an oversized file on Content-Length before buffering the body', async () => {
    // The download advertises an over-cap size via Content-Length; the guard must fire before
    // arrayBuffer() runs.
    let bodyRead = false
    const preCheck: FetchLike = async (url) => {
      if (url.includes('/contents/')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              type: 'file',
              name: 'SKILL.md',
              path: 'pack/foo/SKILL.md',
              download_url: 'https://raw/big'
            }
          ],
          arrayBuffer: async () => new ArrayBuffer(0)
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        headers: {
          get: (name) => (name.toLowerCase() === 'content-length' ? `${OVER_FILE}` : null)
        },
        arrayBuffer: async () => {
          bodyRead = true
          return new ArrayBuffer(0)
        }
      }
    }

    await expect(
      fetchSkillFiles({ owner: 'acme', repo: 'skills', ref: 'main', path: 'pack/foo' }, preCheck)
    ).rejects.toThrow(/exceeds the .* limit/)
    expect(bodyRead).toBe(false)
  })

  it('rejects on the aggregate budget via Content-Length before reading the over-budget body', async () => {
    // Three files each declaring one per-file cap's worth. Two fit the total cap; the third pushes the
    // aggregate over it and must be rejected on its Content-Length — before its body is ever read.
    const bodiesRead: string[] = []
    const size = AT_FILE
    const aggregate: FetchLike = async (url) => {
      if (url.includes('/contents/')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              type: 'file',
              name: 'SKILL.md',
              path: 'pack/foo/SKILL.md',
              download_url: 'https://raw/a'
            },
            { type: 'file', name: 'b.bin', path: 'pack/foo/b.bin', download_url: 'https://raw/b' },
            { type: 'file', name: 'c.bin', path: 'pack/foo/c.bin', download_url: 'https://raw/c' }
          ],
          arrayBuffer: async () => new ArrayBuffer(0)
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        headers: { get: (name) => (name.toLowerCase() === 'content-length' ? `${size}` : null) },
        arrayBuffer: async () => {
          bodiesRead.push(url)
          return new ArrayBuffer(size)
        }
      }
    }

    await expect(
      fetchSkillFiles({ owner: 'acme', repo: 'skills', ref: 'main', path: 'pack/foo' }, aggregate)
    ).rejects.toThrow(/total limit/)
    // First two bodies read, the third rejected before its body was touched.
    expect(bodiesRead).toEqual(['https://raw/a', 'https://raw/b'])
  })

  it('accepts files sitting exactly on the per-file cap', async () => {
    // Two files each exactly at the per-file cap (and within the total cap). Both must be accepted —
    // a file at the cap is allowed, only one over it is rejected.
    const size = AT_FILE
    const exact: FetchLike = async (url) => {
      if (url.includes('/contents/')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              type: 'file',
              name: 'SKILL.md',
              path: 'pack/foo/SKILL.md',
              download_url: 'https://raw/a'
            },
            { type: 'file', name: 'b.bin', path: 'pack/foo/b.bin', download_url: 'https://raw/b' }
          ],
          arrayBuffer: async () => new ArrayBuffer(0)
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        headers: { get: (name) => (name.toLowerCase() === 'content-length' ? `${size}` : null) },
        arrayBuffer: async () => new ArrayBuffer(size)
      }
    }

    const files = await fetchSkillFiles(
      { owner: 'acme', repo: 'skills', ref: 'main', path: 'pack/foo' },
      exact
    )
    expect(files.map((f) => f.relativePath).sort()).toEqual(['SKILL.md', 'b.bin'])
    expect(files.every((f) => f.content.length === size)).toBe(true)
  })

  it('bounds a streamed body with no Content-Length, stopping once the cap is passed', async () => {
    // A body that streams 1 MiB chunks with no Content-Length. Reading must abort once it crosses the
    // per-file cap instead of draining the whole (here effectively endless) stream.
    const capMiB = Math.ceil(SKILL_IMPORT_LIMITS.maxFileBytes / (1024 * 1024))
    let chunksServed = 0
    let cancelled = false
    const chunk = new Uint8Array(1024 * 1024)
    const streaming: FetchLike = async (url) => {
      if (url.includes('/contents/')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              type: 'file',
              name: 'SKILL.md',
              path: 'pack/foo/SKILL.md',
              download_url: 'https://raw/s'
            }
          ],
          arrayBuffer: async () => new ArrayBuffer(0)
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        body: {
          getReader: () => ({
            read: async () => {
              chunksServed += 1
              return { done: false, value: chunk }
            },
            cancel: () => {
              cancelled = true
            }
          })
        },
        arrayBuffer: async () => new ArrayBuffer(0)
      }
    }

    await expect(
      fetchSkillFiles({ owner: 'acme', repo: 'skills', ref: 'main', path: 'pack/foo' }, streaming)
    ).rejects.toThrow(/per-file limit/)
    // Stopped a hair past the cap, not the whole endless stream, and cancelled.
    expect(chunksServed).toBeLessThanOrEqual(capMiB + 2)
    expect(cancelled).toBe(true)
  })

  it('does not hang when the over-limit stream cancel never settles', async () => {
    // cancel() returns a promise that never resolves; the size error must still reject promptly
    // (the cancel is fire-and-forget, not awaited).
    const chunk = new Uint8Array(1024 * 1024)
    const hangingCancel: FetchLike = async (url) => {
      if (url.includes('/contents/')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              type: 'file',
              name: 'SKILL.md',
              path: 'pack/foo/SKILL.md',
              download_url: 'https://raw/s'
            }
          ],
          arrayBuffer: async () => new ArrayBuffer(0)
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        body: {
          getReader: () => ({
            read: async () => ({ done: false, value: chunk }),
            cancel: () => new Promise<void>(() => {}) // never settles
          })
        },
        arrayBuffer: async () => new ArrayBuffer(0)
      }
    }

    await expect(
      fetchSkillFiles(
        { owner: 'acme', repo: 'skills', ref: 'main', path: 'pack/foo' },
        hangingCancel
      )
    ).rejects.toThrow(/per-file limit/)
  })

  it('still reports the size error when cancel() throws synchronously', async () => {
    // A synchronous throw from cancel() must not mask the size-limit error (it escapes before
    // Promise.resolve wraps it, so it needs its own guard).
    const chunk = new Uint8Array(1024 * 1024)
    const throwingCancel: FetchLike = async (url) => {
      if (url.includes('/contents/')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              type: 'file',
              name: 'SKILL.md',
              path: 'pack/foo/SKILL.md',
              download_url: 'https://raw/s'
            }
          ],
          arrayBuffer: async () => new ArrayBuffer(0)
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        body: {
          getReader: () => ({
            read: async () => ({ done: false, value: chunk }),
            cancel: () => {
              throw new Error('synchronous cancel failure')
            }
          })
        },
        arrayBuffer: async () => new ArrayBuffer(0)
      }
    }

    await expect(
      fetchSkillFiles(
        { owner: 'acme', repo: 'skills', ref: 'main', path: 'pack/foo' },
        throwingCancel
      )
    ).rejects.toThrow(/per-file limit/)
  })

  it('reads a streamed body that finishes under the cap and returns its exact bytes', async () => {
    // A finite streamed body (3 MiB in 1 MiB chunks, no Content-Length) under the per-file cap must be
    // accepted and reassembled intact.
    const chunk = new Uint8Array(1024 * 1024).fill(7)
    const finite: FetchLike = async (url) => {
      if (url.includes('/contents/')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              type: 'file',
              name: 'SKILL.md',
              path: 'pack/foo/SKILL.md',
              download_url: 'https://raw/s'
            }
          ],
          arrayBuffer: async () => new ArrayBuffer(0)
        }
      }
      let served = 0
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        body: {
          getReader: () => ({
            read: async () =>
              served++ < 3 ? { done: false, value: chunk } : { done: true, value: undefined }
          })
        },
        arrayBuffer: async () => new ArrayBuffer(0)
      }
    }

    const files = await fetchSkillFiles(
      { owner: 'acme', repo: 'skills', ref: 'main', path: 'pack/foo' },
      finite
    )
    expect(files).toHaveLength(1)
    expect(files[0].content.length).toBe(3 * 1024 * 1024)
    expect(files[0].content.every((b) => b === 7)).toBe(true)
  })

  it('rejects a wide directory tree that exceeds the request budget', async () => {
    // The root lists 600 empty subdirectories; walking them all would exceed the 512-request budget
    // long before any file or byte limit (empty dirs cost nothing against those).
    const wide: FetchLike = async (url) => {
      const isRoot = /\/contents\/pack\/foo(\?|$)/.test(url)
      return {
        ok: true,
        status: 200,
        json: async () =>
          isRoot
            ? Array.from({ length: 600 }, (_, i) => ({
                type: 'dir',
                name: `d${i}`,
                path: `pack/foo/d${i}`
              }))
            : [],
        arrayBuffer: async () => new ArrayBuffer(0)
      }
    }

    await expect(
      fetchSkillFiles({ owner: 'acme', repo: 'skills', ref: 'main', path: 'pack/foo' }, wide)
    ).rejects.toThrow(/exceeded .* requests/)
  })

  it('rejects a repository nested deeper than the depth limit', async () => {
    // Every contents request returns a single subdirectory, so the walk recurses without bound
    // until the depth cap trips.
    const bottomless: FetchLike = async (url) => {
      const match = /\/contents\/(.*?)(\?|$)/.exec(url)
      const path = match ? decodeURIComponent(match[1]) : ''
      return {
        ok: true,
        status: 200,
        json: async () => [{ type: 'dir', name: 'deeper', path: `${path}/deeper` }],
        arrayBuffer: async () => new ArrayBuffer(0)
      }
    }

    await expect(
      fetchSkillFiles({ owner: 'acme', repo: 'skills', ref: 'main', path: 'pack/foo' }, bottomless)
    ).rejects.toThrow(/nesting exceeds/)
  })

  it('rejects a directory with more files than the count limit', async () => {
    // 300 files exceeds the structural cap (SKILL_IMPORT_LIMITS.maxFiles is 256).
    const many = Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [`f${i}.txt`, 'x'])
    ) as Record<string, string>
    await expect(
      fetchSkillFiles(
        { owner: 'acme', repo: 'skills', ref: 'main', path: 'pack/foo' },
        fakeFetch(many)
      )
    ).rejects.toThrow(/too many files/)
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
