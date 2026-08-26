import { describe, expect, it, vi } from 'vitest'

import { SKILL_IMPORT_LIMITS } from './import-limits'
import {
  parseGitHubSkillUrl,
  parseGitHubRepo,
  fetchSkillPreview,
  fetchSkillFiles,
  searchGitHubSkillRepositories,
  scanRepoForSkills,
  createAuthenticatedGitHubFetch,
  type FetchLike
} from './github-import'

// Per-file / total caps the download guards enforce; tests derive sizes from these so they track the
// configured limits instead of hard-coded numbers.
const OVER_FILE = SKILL_IMPORT_LIMITS.maxFileBytes + 1
const AT_FILE = SKILL_IMPORT_LIMITS.maxFileBytes

type FetchSkillFilesWithDeadlines = (
  location: Parameters<typeof fetchSkillFiles>[0],
  fetchImpl: FetchLike,
  options: { requestTimeoutMs: number; totalTimeoutMs: number }
) => ReturnType<typeof fetchSkillFiles>

const hangingFetch = (): FetchLike => (_url, init) =>
  new Promise((_resolve, reject) => {
    const signal = (init as { signal?: AbortSignal } | undefined)?.signal
    if (!signal) {
      reject(new Error('GitHub fetch did not receive an AbortSignal.'))
      return
    }
    const rejectAborted = (): void => reject(signal.reason)
    if (signal.aborted) rejectAborted()
    else signal.addEventListener('abort', rejectAborted, { once: true })
  })

describe('createAuthenticatedGitHubFetch', () => {
  it('adds the token only to exact trusted HTTPS GitHub hosts', async () => {
    const requests: Array<{ url: string; headers?: Record<string, string> }> = []
    const fetcher: FetchLike = async (url, init) => {
      requests.push({ url, headers: init?.headers })
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () => new ArrayBuffer(0)
      }
    }
    const authenticated = createAuthenticatedGitHubFetch(fetcher, ' github_pat_secret ')

    await authenticated('https://api.github.com/rate_limit', {
      headers: { Accept: 'application/vnd.github+json' }
    })
    await authenticated('https://raw.githubusercontent.com/acme/repo/main/SKILL.md')
    await authenticated('https://api.github.com.evil.example/collect')
    await authenticated('http://api.github.com/collect')

    expect(requests).toEqual([
      {
        url: 'https://api.github.com/rate_limit',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer github_pat_secret'
        }
      },
      {
        url: 'https://raw.githubusercontent.com/acme/repo/main/SKILL.md',
        headers: { Authorization: 'Bearer github_pat_secret' }
      },
      { url: 'https://api.github.com.evil.example/collect', headers: {} },
      { url: 'http://api.github.com/collect', headers: {} }
    ])
  })
})

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

  it('returns null unless the URL is an HTTPS github.com repository', () => {
    expect(parseGitHubSkillUrl('https://example.com/foo')).toBeNull()
    expect(parseGitHubSkillUrl('http://github.com/acme/skills')).toBeNull()
    expect(parseGitHubSkillUrl('https://example.invalid/github.com/acme/skills')).toBeNull()
    expect(parseGitHubSkillUrl('https://github.com.evil/acme/skills')).toBeNull()
    expect(parseGitHubSkillUrl('https://github.com/acme')).toBeNull()
    expect(parseGitHubSkillUrl('https://github.com/acme/skills/issues')).toBeNull()
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

describe('fetchSkillPreview', () => {
  it('lists candidate files while downloading only SKILL.md', async () => {
    const downloads: string[] = []
    const fetcher: FetchLike = async (url) => {
      if (url.includes('/contents/')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              type: 'file',
              name: 'SKILL.md',
              path: 'pack/foo/SKILL.md',
              download_url: 'https://raw/SKILL.md'
            },
            {
              type: 'file',
              name: 'guide.md',
              path: 'pack/foo/references/guide.md',
              download_url: 'https://raw/guide.md'
            }
          ],
          arrayBuffer: async () => new ArrayBuffer(0)
        }
      }

      downloads.push(url)
      const bytes = new TextEncoder().encode('# Preview body')
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      }
    }

    await expect(
      fetchSkillPreview({ owner: 'acme', repo: 'skills', ref: 'main', path: 'pack/foo' }, fetcher)
    ).resolves.toEqual({
      skillMd: Buffer.from('# Preview body'),
      files: ['SKILL.md', 'references/guide.md']
    })
    expect(downloads).toEqual(['https://raw/SKILL.md'])
  })

  it('bounds GitHub preview content without preventing import', async () => {
    const bytes = new Uint8Array(SKILL_IMPORT_LIMITS.maxPreviewContentBytes + 1)
    const fetcher: FetchLike = async (url) => {
      if (url.includes('/contents/')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              type: 'file',
              name: 'SKILL.md',
              path: 'pack/foo/SKILL.md',
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
        headers: { get: () => String(bytes.byteLength) },
        arrayBuffer: async () => bytes.buffer
      }
    }
    const location = { owner: 'acme', repo: 'skills', ref: 'main', path: 'pack/foo' }

    await expect(fetchSkillPreview(location, fetcher)).rejects.toThrow(
      /preview exceeds the 4 MB limit/i
    )
    await expect(fetchSkillFiles(location, fetcher)).resolves.toHaveLength(1)
  })

  it('rejects a declared oversized preview before buffering its body', async () => {
    let bodyRead = false
    const fetcher: FetchLike = async (url) => {
      if (url.includes('/contents/')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              type: 'file',
              name: 'SKILL.md',
              path: 'pack/foo/SKILL.md',
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
        headers: {
          get: (name) => (name.toLowerCase() === 'content-length' ? String(OVER_FILE) : null)
        },
        arrayBuffer: async () => {
          bodyRead = true
          return new ArrayBuffer(0)
        }
      }
    }

    await expect(
      fetchSkillPreview({ owner: 'acme', repo: 'skills', ref: 'main', path: 'pack/foo' }, fetcher)
    ).rejects.toThrow(/preview exceeds the 4 MB limit/i)
    expect(bodyRead).toBe(false)
  })
})

describe('fetchSkillFiles', () => {
  it('aborts a stalled GitHub request at the per-request deadline', async () => {
    const fetchWithDeadlines = fetchSkillFiles as unknown as FetchSkillFilesWithDeadlines

    await expect(
      fetchWithDeadlines(
        { owner: 'acme', repo: 'skills', ref: 'main', path: 'pack/foo' },
        hangingFetch(),
        { requestTimeoutMs: 10, totalTimeoutMs: 1_000 }
      )
    ).rejects.toMatchObject({ name: 'TimeoutError' })
  })

  it('aborts a stalled GitHub import at the total-flow deadline', async () => {
    const fetchWithDeadlines = fetchSkillFiles as unknown as FetchSkillFilesWithDeadlines

    await expect(
      fetchWithDeadlines(
        { owner: 'acme', repo: 'skills', ref: 'main', path: 'pack/foo' },
        hangingFetch(),
        { requestTimeoutMs: 1_000, totalTimeoutMs: 10 }
      )
    ).rejects.toMatchObject({ name: 'TimeoutError' })
  })

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

describe('searchGitHubSkillRepositories', () => {
  it('returns compact repository results for Skill keyword searches', async () => {
    const requests: string[] = []
    const fetcher: FetchLike = async (url) => {
      requests.push(url)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            {
              full_name: 'hugohe3/ppt-master',
              description: 'Presentation generation skills',
              html_url: 'https://github.com/hugohe3/ppt-master',
              stargazers_count: 42
            }
          ]
        }),
        arrayBuffer: async () => new ArrayBuffer(0)
      }
    }

    await expect(searchGitHubSkillRepositories('ppt master', fetcher)).resolves.toEqual([
      {
        fullName: 'hugohe3/ppt-master',
        description: 'Presentation generation skills',
        url: 'https://github.com/hugohe3/ppt-master',
        stars: 42
      }
    ])
    expect(requests).toEqual([
      'https://api.github.com/search/repositories?q=ppt%20master%20SKILL.md%20in%3Aname%2Cdescription%2Ctopics%2Creadme&per_page=10'
    ])
  })

  it('rejects keywords longer than GitHub search accepts before fetching', async () => {
    const fetcher = vi.fn<FetchLike>()

    await expect(searchGitHubSkillRepositories('x'.repeat(248), fetcher)).rejects.toThrow(
      'GitHub search is limited to 256 characters. Shorten the keywords or paste an owner/repo reference.'
    )
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    { status: 429, remaining: null, retryAfter: null },
    { status: 403, remaining: '0', retryAfter: null },
    { status: 403, remaining: '12', retryAfter: '30' }
  ])(
    'turns GitHub rate-limit metadata for status $status into an actionable error',
    async ({ status, remaining, retryAfter }) => {
      const fetcher: FetchLike = async () => ({
        ok: false,
        status,
        json: async () => ({}),
        arrayBuffer: async () => new ArrayBuffer(0),
        headers: {
          get: (name) =>
            name === 'x-ratelimit-remaining'
              ? remaining
              : name === 'retry-after'
                ? retryAfter
                : null
        }
      })

      await expect(searchGitHubSkillRepositories('slides', fetcher)).rejects.toThrow(
        'GitHub request was rate-limited. Configure or update the GitHub token on this page, then try again.'
      )
    }
  )

  it('keeps a bare 403 distinct from rate limiting', async () => {
    const fetcher: FetchLike = async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
      arrayBuffer: async () => new ArrayBuffer(0)
    })

    await expect(searchGitHubSkillRepositories('slides', fetcher)).rejects.toThrow(
      'GitHub API request was forbidden (403). Check repository access and token permissions, then try again.'
    )
  })

  it('ignores malformed repository items instead of exposing unchecked data', async () => {
    const fetcher: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          { full_name: 'missing-fields' },
          {
            full_name: 'acme/valid',
            description: null,
            html_url: 'https://github.com/acme/valid',
            stargazers_count: 7
          }
        ]
      }),
      arrayBuffer: async () => new ArrayBuffer(0)
    })

    await expect(searchGitHubSkillRepositories('acme', fetcher)).resolves.toEqual([
      {
        fullName: 'acme/valid',
        description: null,
        url: 'https://github.com/acme/valid',
        stars: 7
      }
    ])
  })

  it('reports a malformed repository-search response explicitly', async () => {
    const fetcher: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ unexpected: true }),
      arrayBuffer: async () => new ArrayBuffer(0)
    })

    await expect(searchGitHubSkillRepositories('acme', fetcher)).rejects.toThrow(
      'GitHub returned an invalid repository search response.'
    )
  })

  it('does not expose JSON parser details from a malformed GitHub response', async () => {
    const fetcher: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token from private response body')
      },
      arrayBuffer: async () => new ArrayBuffer(0)
    })

    await expect(searchGitHubSkillRepositories('acme', fetcher)).rejects.toThrow(
      'GitHub returned an invalid repository search response.'
    )
  })
})

describe('scanRepoForSkills', () => {
  // Fakes the repo-meta + recursive git-tree API responses.
  const commitSha = '0123456789abcdef0123456789abcdef01234567'
  const treeFetch = (
    paths: { path: string; type: string }[],
    defaultBranch = 'main'
  ): FetchLike => {
    return async (url: string) => {
      const body = url.includes('/git/trees/')
        ? { tree: paths }
        : url.includes('/commits/')
          ? { sha: commitSha }
          : { default_branch: defaultBranch }
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
        url: `https://github.com/acme/skills/tree/${commitSha}/pack/foo`
      },
      {
        name: 'bar',
        path: 'bar',
        url: `https://github.com/acme/skills/tree/${commitSha}/bar`
      }
    ])
  })

  it('rejects a truncated recursive tree instead of returning partial scan results', async () => {
    const fetcher: FetchLike = async (url) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.includes('/git/trees/')
          ? {
              truncated: true,
              tree: [{ path: 'pack/foo/SKILL.md', type: 'blob' }]
            }
          : url.includes('/commits/')
            ? { sha: commitSha }
            : { default_branch: 'main' },
      arrayBuffer: async () => new ArrayBuffer(0)
    })

    await expect(scanRepoForSkills({ owner: 'acme', repo: 'very-large' }, fetcher)).rejects.toThrow(
      'This repository is too large to scan completely. Paste a link to the Skill folder instead.'
    )
  })
})
