import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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

it('silently handles a broken cache and an unavailable network', async () => {
  await writeFile(cachePath, '{broken')
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  const catalog = new UseCaseCatalog(directory)
  expect(await catalog.cached()).toEqual([])
  expect(await catalog.refresh()).toEqual([])
})
