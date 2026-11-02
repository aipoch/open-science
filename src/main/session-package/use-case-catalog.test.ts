import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { UseCaseCatalog } from './use-case-catalog'

const manifest = (title: string): unknown[] => [
  {
    name: 'research',
    title,
    cover: { file_name: 'cover.png' },
    case: { file_name: 'case.science', bytes: 3, sha256: 'a'.repeat(64) }
  }
]
let directory: string
let cachePath: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'use-case-catalog-'))
  cachePath = join(directory, 'cache', 'use-cases', 'manifest.json')
  await mkdir(join(directory, 'cache', 'use-cases'), { recursive: true })
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(directory, { recursive: true, force: true })
})

it('serves cached cases while refreshing once and persists the successful replacement', async () => {
  await writeFile(cachePath, JSON.stringify(manifest('Cached')))
  let finish!: (response: Response) => void
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve
      })
  )
  vi.stubGlobal('fetch', fetcher)
  const catalog = new UseCaseCatalog(directory)
  const refresh = catalog.refresh()
  expect((await catalog.cached())[0].title).toBe('Cached')
  finish(Response.json(manifest('Fresh')))
  expect((await refresh)[0].title).toBe('Fresh')
  expect((await catalog.cached())[0].title).toBe('Fresh')
  await catalog.refresh()
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(JSON.parse(await readFile(cachePath, 'utf8'))).toEqual(manifest('Fresh'))
  const nextLaunch = new UseCaseCatalog(directory)
  expect((await nextLaunch.cached())[0].title).toBe('Fresh')
  const nextRefresh = nextLaunch.refresh()
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
  finish(Response.json(manifest('Next launch')))
  expect((await nextRefresh)[0].title).toBe('Next launch')
})

it.each(['network', 'invalid', 'http'])(
  'keeps the cache after a %s failure without rejecting',
  async (failure) => {
    await writeFile(cachePath, JSON.stringify(manifest('Cached')))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (failure === 'network') throw new Error('offline')
        return failure === 'http'
          ? new Response(null, { status: 503 })
          : Response.json([{ name: '../bad' }])
      })
    )
    const catalog = new UseCaseCatalog(directory)
    expect((await catalog.refresh())[0].title).toBe('Cached')
    expect(JSON.parse(await readFile(cachePath, 'utf8'))).toEqual(manifest('Cached'))
  }
)

it.each([false, true])(
  'serves fresh cases despite cache write failure (old cache: %s) and retries persistence',
  async (hasOldCache) => {
    if (hasOldCache) await writeFile(cachePath, JSON.stringify(manifest('Old')))
    // A directory at the temporary-file path rejects writes on every supported OS.
    await mkdir(`${cachePath}.tmp`)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(manifest('Fresh')))
    )
    const catalog = new UseCaseCatalog(directory)
    expect((await catalog.refresh(true))[0].title).toBe('Fresh')
    expect((await catalog.cached())[0].title).toBe('Fresh')
    if (hasOldCache) expect(JSON.parse(await readFile(cachePath, 'utf8'))).toEqual(manifest('Old'))

    await rm(`${cachePath}.tmp`, { recursive: true })
    await catalog.refresh(true)
    expect(JSON.parse(await readFile(cachePath, 'utf8'))).toEqual(manifest('Fresh'))
    const restarted = new UseCaseCatalog(directory)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      })
    )
    expect((await restarted.refresh())[0].title).toBe('Fresh')
  }
)

it('serves a valid catalog even when its cache directory cannot be created', async () => {
  const unavailableRoot = join(directory, 'not-a-directory')
  await writeFile(unavailableRoot, '')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(manifest('Fresh')))
  )
  const catalog = new UseCaseCatalog(unavailableRoot)
  expect((await catalog.refresh())[0].title).toBe('Fresh')
  expect((await catalog.cached())[0].title).toBe('Fresh')
})

it('reports first-load failure when no valid cached catalog is available', async () => {
  await writeFile(cachePath, '{broken')
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  const catalog = new UseCaseCatalog(directory)
  expect(await catalog.cached()).toEqual([])
  await expect(catalog.refresh()).rejects.toThrow('offline')
})

it('resolves introductions from the catalog, caches successful reads and retries failures', async () => {
  await writeFile(
    cachePath,
    JSON.stringify([
      { ...(manifest('Research')[0] as object), introduction: { file_name: 'Intro.md' } }
    ])
  )
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(new Response('# Research\n\nPublished findings.'))
  vi.stubGlobal('fetch', fetcher)
  const catalog = new UseCaseCatalog(directory)
  await expect(catalog.introduction('research')).rejects.toThrow()
  expect(await catalog.introduction('research')).toBe('# Research\n\nPublished findings.')
  expect(await catalog.introduction('research')).toContain('Published findings.')
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(fetcher.mock.calls[1][0]).toBe(
    'https://statics.aipoch.com/open-science/usecases/research/Intro.md'
  )
  await expect(catalog.introduction('../private')).rejects.toThrow()
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('returns no introduction for older entries and rejects oversized introduction bodies', async () => {
  await writeFile(cachePath, JSON.stringify(manifest('Research')))
  expect(await new UseCaseCatalog(directory).introduction('research')).toBeNull()
  await writeFile(
    cachePath,
    JSON.stringify([
      { ...(manifest('Research')[0] as object), introduction: { file_name: 'Intro.md' } }
    ])
  )
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x'.repeat(1024 * 1024 + 1))))
  await expect(new UseCaseCatalog(directory).introduction('research')).rejects.toThrow()
})

it('shares an in-flight introduction and reuses it from disk after restarting', async () => {
  await writeFile(
    cachePath,
    JSON.stringify([
      { ...(manifest('Research')[0] as object), introduction: { file_name: 'Intro.md' } }
    ])
  )
  let finish!: (response: Response) => void
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve
      })
  )
  vi.stubGlobal('fetch', fetcher)
  const catalog = new UseCaseCatalog(directory)
  const first = catalog.introduction('research')
  const second = catalog.introduction('research')
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
  finish(new Response('# Cached introduction'))
  expect(await first).toBe('# Cached introduction')
  expect(await second).toBe('# Cached introduction')
  fetcher.mockRejectedValue(new Error('Network should not be needed'))
  expect(await new UseCaseCatalog(directory).introduction('research')).toBe('# Cached introduction')
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('refreshes expired introduction files and bounds the disk cache', async () => {
  await writeFile(
    cachePath,
    JSON.stringify(
      Array.from({ length: 33 }, (_, index) => ({
        ...(manifest('Research')[0] as object),
        name: `research-${index}`,
        introduction: { file_name: 'Intro.md' }
      }))
    )
  )
  const fetcher = vi.fn(async () => new Response('# Fresh'))
  vi.stubGlobal('fetch', fetcher)
  const catalog = new UseCaseCatalog(directory)
  await catalog.introduction('research-0')
  const folder = join(directory, 'cache', 'use-cases', 'introductions')
  const [cachedFile] = await readdir(folder)
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
  await utimes(join(folder, cachedFile), old, old)
  fetcher.mockImplementation(async () => new Response('# Updated'))
  expect(await new UseCaseCatalog(directory).introduction('research-0')).toBe('# Updated')
  for (let index = 1; index < 33; index++) await catalog.introduction(`research-${index}`)
  expect((await readdir(folder)).filter((name) => name.endsWith('.md'))).toHaveLength(32)
})

it('explicitly reloads the catalog, shares concurrent requests and replaces the disk cache', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(manifest('Original')))
  vi.stubGlobal('fetch', fetcher)
  const catalog = new UseCaseCatalog(directory)
  await catalog.refresh()
  let finish!: (response: Response) => void
  fetcher.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve
      })
  )
  const first = catalog.refresh(true)
  const second = catalog.refresh(true)
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
  finish(Response.json(manifest('Updated')))
  expect((await first)[0].title).toBe('Updated')
  expect(await second).toEqual(await first)
  expect(fetcher.mock.calls[1][1]).toMatchObject({ cache: 'no-store' })
  expect((await catalog.refresh())[0].title).toBe('Updated')
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect((await new UseCaseCatalog(directory).cached())[0].title).toBe('Updated')
})

it.each(['network', 'invalid', 'http'])(
  'reports manual %s refresh failures, preserves the cache and allows retry',
  async (failure) => {
    await writeFile(cachePath, JSON.stringify(manifest('Cached')))
    const fetcher = vi.fn(async () => {
      if (failure === 'network') throw new Error('offline')
      return failure === 'http'
        ? new Response(null, { status: 503 })
        : Response.json({ invalid: true })
    })
    vi.stubGlobal('fetch', fetcher)
    const catalog = new UseCaseCatalog(directory)
    await expect(catalog.refresh(true)).rejects.toThrow()
    expect((await catalog.cached())[0].title).toBe('Cached')
    expect(JSON.parse(await readFile(cachePath, 'utf8'))).toEqual(manifest('Cached'))
    fetcher.mockResolvedValue(Response.json(manifest('Recovered')))
    expect((await catalog.refresh(true))[0].title).toBe('Recovered')
  }
)

it('manually refreshes only cached introductions, including disk entries from a previous launch', async () => {
  const entries = ['research', 'unopened'].map((name) => ({
    ...(manifest('Research')[0] as object),
    name,
    introduction: { file_name: 'Intro.md' }
  }))
  await writeFile(cachePath, JSON.stringify(entries))
  let content = '# Original'
  const requested: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      requested.push(input)
      return input.endsWith('manifest.json') ? Response.json(entries) : new Response(content)
    })
  )
  await new UseCaseCatalog(directory).introduction('research')
  const catalog = new UseCaseCatalog(directory)
  content = '# Updated'
  await catalog.refresh(true)
  expect(await catalog.introduction('research')).toBe('# Updated')
  expect(requested.filter((url) => url.includes('unopened'))).toHaveLength(0)
  expect(await new UseCaseCatalog(directory).introduction('research')).toBe('# Updated')
})

it('keeps cached introductions on refresh failure and replaces them on a later successful retry', async () => {
  const entries = [
    { ...(manifest('Research')[0] as object), introduction: { file_name: 'Intro.md' } }
  ]
  await writeFile(cachePath, JSON.stringify(entries))
  let content = '# Original'
  let fail = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      if (input.endsWith('manifest.json')) return Response.json(entries)
      if (fail) throw new Error('offline')
      return new Response(content)
    })
  )
  const catalog = new UseCaseCatalog(directory)
  await catalog.introduction('research')
  fail = true
  await catalog.refresh(true)
  expect(await catalog.introduction('research')).toBe('# Original')
  fail = false
  content = '# Recovered'
  await catalog.refresh(true)
  expect(await catalog.introduction('research')).toBe('# Recovered')
})

it('does not rewrite unchanged cached content or replace the catalog identities', async () => {
  const entries = [
    { ...(manifest('Research')[0] as object), introduction: { file_name: 'Intro.md' } }
  ]
  await writeFile(cachePath, JSON.stringify(entries))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) =>
      input.endsWith('manifest.json') ? Response.json(entries) : new Response('# Same')
    )
  )
  const catalog = new UseCaseCatalog(directory)
  const before = await catalog.cached()
  await catalog.introduction('research')
  const folder = join(directory, 'cache', 'use-cases', 'introductions')
  const [file] = await readdir(folder)
  const { stat } = await import('node:fs/promises')
  const manifestBefore = await stat(cachePath)
  const bodyBefore = await stat(join(folder, file))
  await catalog.refresh(true)
  expect(await catalog.cached()).toBe(before)
  expect((await stat(cachePath)).ino).toBe(manifestBefore.ino)
  expect((await stat(join(folder, file))).ino).toBe(bodyBefore.ino)
  expect(await readFile(join(folder, file), 'utf8')).toBe('# Same')
})

it('does not let an older in-flight introduction overwrite the manual refresh', async () => {
  const entries = [
    { ...(manifest('Research')[0] as object), introduction: { file_name: 'Intro.md' } }
  ]
  await writeFile(cachePath, JSON.stringify(entries))
  let finish!: (response: Response) => void
  let bodyRequests = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      if (input.endsWith('manifest.json')) return Response.json(entries)
      if (++bodyRequests === 1)
        return new Promise<Response>((resolve) => {
          finish = resolve
        })
      return new Response('# New')
    })
  )
  const catalog = new UseCaseCatalog(directory)
  const oldRequest = catalog.introduction('research')
  await vi.waitFor(() => expect(bodyRequests).toBe(1))
  const refresh = catalog.refresh(true)
  finish(new Response('# Old'))
  await oldRequest
  await refresh
  expect(await catalog.introduction('research')).toBe('# New')
})

it('honors a manual refresh requested while the automatic catalog refresh is still running', async () => {
  const entries = [
    { ...(manifest('Research')[0] as object), introduction: { file_name: 'Intro.md' } }
  ]
  await writeFile(cachePath, JSON.stringify(entries))
  let finish!: (response: Response) => void
  let body = '# Original'
  let catalogs = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (!url.endsWith('manifest.json')) return new Response(body)
      if (++catalogs === 1)
        return new Promise<Response>((resolve) => {
          finish = resolve
        })
      return Response.json(entries)
    })
  )
  const catalog = new UseCaseCatalog(directory)
  await catalog.introduction('research')
  const automatic = catalog.refresh()
  await vi.waitFor(() => expect(catalogs).toBe(1))
  body = '# Updated'
  const manual = catalog.refresh(true)
  finish(Response.json(entries))
  await automatic
  await manual
  expect(await catalog.introduction('research')).toBe('# Updated')
})

it('limits background checks to three concurrent requests', async () => {
  const entries = Array.from({ length: 5 }, (_, index) => ({
    ...(manifest('Research')[0] as object),
    name: `research-${index}`,
    introduction: { file_name: 'Intro.md' }
  }))
  await writeFile(cachePath, JSON.stringify(entries))
  let revalidating = false
  let active = 0
  let peak = 0
  const finishes: (() => void)[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('manifest.json')) return Response.json(entries)
      if (!revalidating) return new Response('# Original')
      active++
      peak = Math.max(peak, active)
      return new Promise<Response>((resolve) =>
        finishes.push(() => {
          active--
          resolve(new Response('# Updated'))
        })
      )
    })
  )
  const catalog = new UseCaseCatalog(directory)
  for (let index = 0; index < 5; index++) await catalog.introduction(`research-${index}`)
  revalidating = true
  const refresh = catalog.refresh(true)
  await vi.waitFor(() => expect(finishes).toHaveLength(3))
  finishes.splice(0).forEach((finish) => finish())
  await vi.waitFor(() => expect(finishes).toHaveLength(2))
  finishes.splice(0).forEach((finish) => finish())
  await refresh
  expect(peak).toBe(3)
  for (let index = 0; index < 5; index++)
    expect(await catalog.introduction(`research-${index}`)).toBe('# Updated')
})

it.each([6, 8])(
  'prioritizes unfinished bodies across refresh deadlines for %i cached cases',
  async (size) => {
    const entries = Array.from({ length: size }, (_, index) => ({
      ...(manifest('Research')[0] as object),
      name: `research-${index}`,
      introduction: { file_name: 'Intro.md' }
    }))
    await writeFile(cachePath, JSON.stringify(entries))
    let checking = false
    const finishes: (() => void)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options?: RequestInit) => {
        if (url.endsWith('manifest.json')) return Response.json(entries)
        if (!checking) return new Response('# Original')
        return new Promise<Response>((resolve, reject) => {
          const signal = options!.signal!
          const abort = (): void => reject(signal.reason)
          signal.addEventListener('abort', abort, { once: true })
          finishes.push(() => {
            signal.removeEventListener('abort', abort)
            resolve(new Response('# Updated'))
          })
        })
      })
    )
    const catalog = new UseCaseCatalog(directory)
    for (const entry of entries) await catalog.introduction(entry.name)
    checking = true
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    try {
      // Each pass finishes one batch and interrupts the next, possibly leaving URLs unstarted.
      for (let pass = 0; pass < 4; pass++) {
        const deadline = new AbortController()
        timeout.mockReturnValue(deadline.signal)
        const refresh = catalog.refresh(true)
        await vi.waitFor(() => expect(finishes).toHaveLength(3))
        finishes.splice(0).forEach((finish) => finish())
        await vi.waitFor(() => expect(finishes).toHaveLength(3))
        deadline.abort(new DOMException('Timed out', 'TimeoutError'))
        await refresh
        finishes.splice(0)
      }
    } finally {
      timeout.mockRestore()
    }
    for (const entry of entries) expect(await catalog.introduction(entry.name)).toBe('# Updated')
  }
)

it('revalidates the replacement URL when a previously viewed case changes introduction files', async () => {
  const entry = { ...(manifest('Research')[0] as object), introduction: { file_name: 'Intro.md' } }
  await writeFile(cachePath, JSON.stringify([entry]))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('manifest.json')
        ? Response.json([{ ...entry, introduction: { file_name: 'Updated.md' } }])
        : new Response(url.endsWith('/Updated.md') ? '# New file' : '# Original')
    )
  )
  const catalog = new UseCaseCatalog(directory)
  await catalog.introduction('research')
  await catalog.refresh(true)
  expect(await catalog.introduction('research')).toBe('# New file')
})

it('keeps expired disk content readable if a manual background check fails offline', async () => {
  const entries = [
    { ...(manifest('Research')[0] as object), introduction: { file_name: 'Intro.md' } }
  ]
  await writeFile(cachePath, JSON.stringify(entries))
  const fetcher = vi.fn(async (url: string) =>
    url.endsWith('manifest.json') ? Response.json(entries) : new Response('# Saved')
  )
  vi.stubGlobal('fetch', fetcher)
  await new UseCaseCatalog(directory).introduction('research')
  const folder = join(directory, 'cache', 'use-cases', 'introductions')
  const [file] = await readdir(folder)
  const expired = new Date(Date.now() - 25 * 60 * 60 * 1000)
  await utimes(join(folder, file), expired, expired)
  fetcher.mockImplementation(async (url: string) => {
    if (url.endsWith('manifest.json')) return Response.json(entries)
    throw new Error('offline')
  })
  const catalog = new UseCaseCatalog(directory)
  await catalog.refresh(true)
  expect(await catalog.introduction('research')).toBe('# Saved')
  expect(await readFile(join(folder, file), 'utf8')).toBe('# Saved')
})

it('keeps a successfully loaded empty catalog distinct from an initial fetch failure', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json([]))
  vi.stubGlobal('fetch', fetcher)
  const catalog = new UseCaseCatalog(directory)
  expect(await catalog.refresh()).toEqual([])
  fetcher.mockRejectedValue(new Error('offline'))
  const nextLaunch = new UseCaseCatalog(directory)
  expect(await nextLaunch.refresh()).toEqual([])
})
