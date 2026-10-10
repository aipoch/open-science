import { gzipSync } from 'node:zlib'
import { mkdtemp, readFile, readdir, realpath, rm, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../types'
import { download, listDatasets, DATASETS } from './download'
import * as downloadRuntime from './download'
import { defaultFileDurability } from '../../storage/file-durability'
import * as encoriFiles from './client'
import { ENCORI_TOOLS } from '../descriptors/encori'
import { ParserEngine } from '../engine'
const fetchMock = vi.hoisted(() => vi.fn())
vi.mock('../../skills/net-fetch', () => ({ netFetchStandard: fetchMock }))
let directory: string
const filename = 'hg38.miRNA_sncRNA.tar.gz'
const item = DATASETS.find((value) => value.filename === filename)!
const gzip = gzipSync('actual official fixture bytes')
const ctx = { credentials: {} } as ToolContext
const headers = {
  'content-length': String(gzip.length),
  etag: '"fixture"',
  'accept-ranges': 'bytes'
}
const identity = {
  download_url: item.download_url,
  expected_size: gzip.length,
  etag: '"fixture"',
  last_modified: null
}
const args = (): Record<string, unknown> => ({ filename, destination_dir: directory })
const part = (): string => join(directory, `${filename}.part`)
const partial = async (offset: number): Promise<void> => {
  await writeFile(part(), gzip.subarray(0, offset))
  await writeFile(`${part()}.meta.json`, JSON.stringify(identity))
}
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'encori-download-')))
  fetchMock.mockReset()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

describe('ENCORI bulk files', () => {
  it.each([
    'owner',
    'schema_version',
    'partial_path',
    'missing-owner',
    'missing-version',
    'missing-path'
  ])('preserves an existing partial file and rejects a receipt with invalid %s', async (field) => {
    await partial(10)
    const metadata: Record<string, unknown> = {
      ...identity,
      owner: 'open-science.encori.download',
      schema_version: 1,
      partial_path: part()
    }
    if (field === 'missing-owner') delete metadata.owner
    else if (field === 'missing-version') delete metadata.schema_version
    else if (field === 'missing-path') delete metadata.partial_path
    else metadata[field] = field === 'schema_version' ? 2 : 'wrong'
    const content = JSON.stringify(metadata)
    await writeFile(`${part()}.meta.json`, content)
    fetchMock.mockResolvedValue(new Response(null, { headers }))
    await expect(download(ctx, args())).rejects.toMatchObject({ code: 'download_metadata_error' })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(await readFile(part())).toEqual(gzip.subarray(0, 10))
    expect(await readFile(`${part()}.meta.json`, 'utf8')).toBe(content)
    expect(await readdir(directory)).not.toContain(filename)
  })
  it('rejects a mismatched receipt for a complete partial before verification or publication', async () => {
    await partial(gzip.length)
    await writeFile(
      `${part()}.meta.json`,
      JSON.stringify({
        ...identity,
        owner: 'open-science.encori.download',
        schema_version: 1,
        partial_path: join(directory, 'other.part')
      })
    )
    fetchMock.mockResolvedValue(new Response(null, { headers }))
    await expect(download(ctx, args())).rejects.toMatchObject({ code: 'download_metadata_error' })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(await readFile(part())).toEqual(gzip)
    expect(await readdir(directory)).not.toContain(filename)
  })
  it('resumes an existing partial with a matching new receipt and official identity', async () => {
    await partial(10)
    await writeFile(
      `${part()}.meta.json`,
      JSON.stringify({
        ...identity,
        owner: 'open-science.encori.download',
        schema_version: 1,
        partial_path: part()
      })
    )
    fetchMock.mockResolvedValueOnce(new Response(null, { headers })).mockResolvedValueOnce(
      new Response(gzip.subarray(10), {
        status: 206,
        headers: { ...headers, 'content-range': `bytes 10-${gzip.length - 1}/${gzip.length}` }
      })
    )
    const result = await download(ctx, args())
    expect(result).toMatchObject({ verified_gzip: true, resumed_from_bytes: 10 })
    expect(await readFile(String(result.saved_path))).toEqual(gzip)
  })
  it('propagates the whole-call deadline and retains a partial that the same tool can resume', async () => {
    const descriptor = ENCORI_TOOLS.find((tool) => tool.id === 'download_bulk_dataset')!
    const operation = vi.spyOn(downloadRuntime, 'download')
    fetchMock.mockResolvedValueOnce(new Response(null, { headers })).mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(gzip.subarray(0, 10))
          }
        }),
        { headers }
      )
    )
    // A shorter fixture deadline exercises the engine's real deadline/cancellation path.
    const pending = new ParserEngine().call({ ...descriptor, totalTimeoutMs: 1000 }, args(), {})
    await expect(pending).rejects.toThrow('total deadline')
    // The engine rejects immediately; wait for the descriptor's handle flush and guard release.
    await expect(operation.mock.results[0].value).rejects.toThrow('total deadline')
    expect(await readFile(part())).toEqual(gzip.subarray(0, 10))
    expect(await readdir(directory)).not.toContain(filename)
    fetchMock.mockResolvedValueOnce(new Response(null, { headers })).mockResolvedValueOnce(
      new Response(gzip.subarray(10), {
        status: 206,
        headers: { ...headers, 'content-range': `bytes 10-${gzip.length - 1}/${gzip.length}` }
      })
    )
    const result = (await new ParserEngine().call(descriptor, args(), {})) as Record<
      string,
      unknown
    >
    expect(result).toMatchObject({ verified_gzip: true, resumed_from_bytes: 10 })
    expect(await readFile(String(result.saved_path))).toEqual(gzip)
  })
  it('checks cancellation after fallback copying and flushing on a volume without hard links', async () => {
    await partial(gzip.length)
    const controller = new AbortController()
    const options = encoriFiles.publicationOptions
    vi.spyOn(encoriFiles, 'publicationOptions').mockImplementation((signal) => ({
      ...options(signal),
      linkFile: async () => {
        throw Object.assign(new Error('No hard links'), { code: 'ENOTSUP' })
      }
    }))
    const syncFile = defaultFileDurability.syncFile
    const barrier = vi.spyOn(defaultFileDurability, 'syncFile').mockImplementation(async (path) => {
      await syncFile(path)
      if (path.includes('.open-science-publish-'))
        controller.abort(new Error('cancel fallback publication'))
    })
    fetchMock.mockResolvedValue(new Response(null, { headers }))
    await expect(download({ ...ctx, signal: controller.signal }, args())).rejects.toThrow(
      'cancel fallback publication'
    )
    expect(await readdir(directory)).toEqual([`${filename}.part`, `${filename}.part.meta.json`])
    expect(await readFile(part())).toEqual(gzip)
    barrier.mockRestore()
    const result = await download(ctx, args())
    expect(result.verified_gzip).toBe(true)
    expect(await readFile(String(result.saved_path))).toEqual(gzip)
    expect(await readdir(directory)).toEqual([filename])
  })
  it('recovers an interrupted initialization after metadata publication without adopting legacy metadata', async () => {
    const controller = new AbortController()
    const syncDirectory = defaultFileDurability.syncDirectory
    vi.spyOn(defaultFileDurability, 'syncDirectory').mockImplementationOnce(async (path) => {
      await syncDirectory(path)
      controller.abort(new Error('cancel initialization'))
    })
    fetchMock
      .mockResolvedValueOnce(new Response(null, { headers }))
      .mockResolvedValueOnce(new Response(gzip, { headers }))
    await expect(download({ ...ctx, signal: controller.signal }, args())).rejects.toThrow(
      'cancel initialization'
    )
    expect(await readdir(directory)).toEqual([`${filename}.part.meta.json`])
    const metadata = JSON.parse(await readFile(`${part()}.meta.json`, 'utf8'))
    expect(metadata).toMatchObject({
      ...identity,
      owner: 'open-science.encori.download',
      schema_version: 1,
      partial_path: part()
    })
    fetchMock
      .mockResolvedValueOnce(new Response(null, { headers }))
      .mockResolvedValueOnce(new Response(gzip, { headers }))
    const recovered = await download(ctx, args())
    expect(recovered).toMatchObject({ verified_gzip: true, resumed: false })
    expect(await readFile(String(recovered.saved_path))).toEqual(gzip)
    expect(await readdir(directory)).toEqual([filename])
  })
  it.each(['legacy', 'wrong-path', 'changed-identity'])(
    'preserves orphan metadata with %s ownership or identity',
    async (kind) => {
      const metadata =
        kind === 'legacy'
          ? identity
          : {
              ...identity,
              owner: 'open-science.encori.download',
              schema_version: 1,
              partial_path: kind === 'wrong-path' ? join(directory, 'other.part') : part(),
              ...(kind === 'changed-identity' ? { etag: '"old"' } : {})
            }
      const content = JSON.stringify(metadata)
      await writeFile(`${part()}.meta.json`, content)
      fetchMock.mockResolvedValue(new Response(null, { headers }))
      await expect(download(ctx, args())).rejects.toMatchObject({
        code: kind === 'changed-identity' ? 'remote_file_changed' : 'orphan_download_metadata'
      })
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(await readFile(`${part()}.meta.json`, 'utf8')).toBe(content)
      expect(await readdir(directory)).toEqual([`${filename}.part.meta.json`])
    }
  )
  it('does not publish a verified download when cancelled during the final durability barrier, and can retry', async () => {
    await partial(gzip.length)
    const controller = new AbortController()
    const syncFile = defaultFileDurability.syncFile
    vi.spyOn(defaultFileDurability, 'syncFile').mockImplementationOnce(async (path) => {
      await syncFile(path)
      controller.abort(new Error('cancel publication'))
    })
    fetchMock.mockResolvedValue(new Response(null, { headers }))
    await expect(download({ ...ctx, signal: controller.signal }, args())).rejects.toThrow(
      'cancel publication'
    )
    expect(await readdir(directory)).toEqual([`${filename}.part`, `${filename}.part.meta.json`])
    expect(await readFile(part())).toEqual(gzip)
    const result = await download(ctx, args())
    expect(result).toMatchObject({ verified_gzip: true, resumed_from_bytes: gzip.length })
    expect(await readdir(directory)).toEqual([filename])
    expect(fetchMock.mock.calls.every(([, init]) => init.method === 'HEAD')).toBe(true)
  })
  it('lists without GET or filesystem writes and preserves unknown unchecked sizes', async () => {
    const result = await listDatasets(ctx, {
      assembly: 'hg38',
      data_type: 'miRNA_sncRNA',
      check_availability: false
    })
    expect(result.files).toEqual([
      {
        ...item,
        available: null,
        size_bytes: null,
        size_mib: null,
        etag: null,
        last_modified: null,
        accept_ranges: null,
        content_type: null
      }
    ])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await readdir(directory)).toEqual([])
  })
  it('HEAD probes one filtered file without downloading the body', async () => {
    fetchMock.mockResolvedValue(new Response(null, { headers }))
    const result = await listDatasets(ctx, { assembly: 'hg38', data_type: 'miRNA_sncRNA' })
    expect(fetchMock.mock.calls[0][1].method).toBe('HEAD')
    expect((result.files as Record<string, unknown>[])[0].size_bytes).toBe(gzip.length)
    expect(await readdir(directory)).toEqual([])
  })
  it('retains per-file failure instead of declaring all files available', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }))
    const result = await listDatasets(ctx, { assembly: 'hg38', data_type: 'miRNA_sncRNA' })
    expect(result.ok).toBe(false)
    expect((result.files as Record<string, unknown>[])[0].available).toBe(false)
  })
  it('streams a real gzip, verifies it and publishes an actual file', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { headers }))
      .mockResolvedValueOnce(new Response(gzip, { headers }))
    const result = await download(ctx, args())
    expect(result.verified_gzip).toBe(true)
    expect(result.size_bytes).toBe(gzip.length)
    expect(await readFile(String(result.saved_path))).toEqual(gzip)
    expect(await readdir(directory)).toEqual([filename])
  })
  it('resumes only the matching official identity and exact range', async () => {
    await partial(10)
    fetchMock.mockResolvedValueOnce(new Response(null, { headers })).mockResolvedValueOnce(
      new Response(gzip.subarray(10), {
        status: 206,
        headers: { ...headers, 'content-range': `bytes 10-${gzip.length - 1}/${gzip.length}` }
      })
    )
    const result = await download(ctx, args())
    expect(fetchMock.mock.calls[1][1].headers.Range).toBe('bytes=10-')
    expect(fetchMock.mock.calls[1][1].headers['If-Range']).toBe('"fixture"')
    expect(result.resumed_from_bytes).toBe(10)
    expect(await readFile(String(result.saved_path))).toEqual(gzip)
  })
  it.each([200, 206])(
    'does not append when the server ignores or misstates a range (%s)',
    async (status) => {
      await partial(10)
      fetchMock.mockResolvedValueOnce(new Response(null, { headers })).mockResolvedValueOnce(
        new Response(gzip, {
          status,
          headers: { 'content-range': `bytes 0-${gzip.length - 1}/${gzip.length}` }
        })
      )
      await expect(download(ctx, args())).rejects.toMatchObject({ code: 'unsafe_resume_response' })
      expect(await readFile(part())).toEqual(gzip.subarray(0, 10))
    }
  )
  it('rejects changed upstream identity before GET', async () => {
    await partial(10)
    fetchMock.mockResolvedValue(new Response(null, { headers: { ...headers, etag: '"changed"' } }))
    await expect(download(ctx, args())).rejects.toMatchObject({ code: 'remote_file_changed' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await readFile(part())).toEqual(gzip.subarray(0, 10))
  })
  it('preserves incomplete downloads for a later call', async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      if (init.method === 'HEAD') return new Response(null, { headers })
      const range = init.headers.Range
      if (!range) return new Response(gzip.subarray(0, 10), { headers })
      return new Response(new Uint8Array(), {
        status: 206,
        headers: { ...headers, 'content-range': `bytes 10-${gzip.length - 1}/${gzip.length}` }
      })
    })
    await expect(download(ctx, args())).rejects.toMatchObject({
      code: 'incomplete_download',
      retryable: true
    })
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(await readFile(part())).toEqual(gzip.subarray(0, 10))
    expect(await readdir(directory)).toContain(`${filename}.part.meta.json`)
    expect(await readdir(directory)).not.toContain(filename)
  })
  it('rejects corrupt gzip despite a matching size and never publishes it', async () => {
    const broken = Buffer.from(gzip)
    broken[broken.length - 5] ^= 255
    fetchMock
      .mockResolvedValueOnce(new Response(null, { headers }))
      .mockResolvedValueOnce(new Response(broken, { headers }))
    await expect(download(ctx, args())).rejects.toThrow()
    expect(await readdir(directory)).not.toContain(filename)
    expect(await readFile(part())).toEqual(broken)
  })
  it('never overwrites a destination and does not request it', async () => {
    await writeFile(join(directory, filename), 'keep existing')
    await expect(download(ctx, args())).rejects.toMatchObject({ code: 'file_exists' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await readFile(join(directory, filename), 'utf8')).toBe('keep existing')
  })
  it('rejects a symlink partial file without writing its target', async () => {
    const other = join(directory, 'other')
    await writeFile(other, 'keep')
    await symlink(other, part())
    fetchMock.mockResolvedValue(new Response(null, { headers }))
    await expect(download(ctx, args())).rejects.toMatchObject({ code: 'partial_file_invalid' })
    expect(await readFile(other, 'utf8')).toBe('keep')
  })
  it('rejects an untracked legacy partial with a useful error code', async () => {
    await writeFile(part(), 'legacy')
    fetchMock.mockResolvedValue(new Response(null, { headers }))
    await expect(download(ctx, args())).rejects.toMatchObject({ code: 'partial_metadata_missing' })
    expect(await readFile(part(), 'utf8')).toBe('legacy')
  })
  it('rejects overlapping calls and releases its guard on cancellation without a lock file', async () => {
    const controller = new AbortController()
    fetchMock
      .mockResolvedValueOnce(new Response(null, { headers }))
      .mockResolvedValueOnce(new Response(new ReadableStream()))
    const first = download({ ...ctx, signal: controller.signal }, args())
    const rejected = expect(first).rejects.toThrow('user cancelled')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await vi.waitFor(async () => expect(await readdir(directory)).toContain(`${filename}.part`))
    await expect(download(ctx, args())).rejects.toMatchObject({ code: 'download_in_progress' })
    controller.abort(new Error('user cancelled'))
    await rejected
    expect((await readdir(directory)).some((name) => name.endsWith('.lock'))).toBe(false)
    fetchMock
      .mockResolvedValueOnce(new Response(null, { headers }))
      .mockResolvedValueOnce(new Response(gzip, { headers }))
    const resumed = await download(ctx, args())
    expect(resumed.verified_gzip).toBe(true)
    expect(await readFile(String(resumed.saved_path))).toEqual(gzip)
  })
  it('retries an interrupted stream from the flushed offset within the same call', async () => {
    let pulls = 0
    const interrupted = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (++pulls === 1) controller.enqueue(gzip.subarray(0, 10))
          else controller.error(new TypeError('connection lost'))
        }
      },
      { highWaterMark: 0 }
    )
    fetchMock
      .mockResolvedValueOnce(new Response(null, { headers }))
      .mockResolvedValueOnce(new Response(interrupted, { headers }))
      .mockResolvedValueOnce(
        new Response(gzip.subarray(10), {
          status: 206,
          headers: { ...headers, 'content-range': `bytes 10-${gzip.length - 1}/${gzip.length}` }
        })
      )
    const result = await download(ctx, args())
    expect(fetchMock.mock.calls[2][1].headers.Range).toBe('bytes=10-')
    expect(result.resumed_from_bytes).toBe(10)
    expect(result.verified_gzip).toBe(true)
    expect(await readFile(String(result.saved_path))).toEqual(gzip)
  })
  it('supports servers without Content-Length while still verifying gzip integrity', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { headers: { etag: '"fixture"' } }))
      .mockResolvedValueOnce(new Response(gzip))
    const result = await download(ctx, args())
    expect(result.verified_gzip).toBe(true)
    expect(result.size_bytes).toBe(gzip.length)
  })
  it('retains a valid gzip member when a range declares more data than was received', async () => {
    const remaining = gzipSync('second complete gzip member')
    const total = gzip.length + remaining.length
    const unknownHeaders = { etag: headers.etag, 'accept-ranges': 'bytes' }
    await writeFile(part(), gzip.subarray(0, 10))
    const metadata = JSON.stringify({ ...identity, expected_size: null })
    await writeFile(`${part()}.meta.json`, metadata)
    fetchMock.mockImplementation(async (_url, init) => {
      if (init.method === 'HEAD') return new Response(null, { headers: unknownHeaders })
      const initial = init.headers.Range === 'bytes=10-'
      return new Response(initial ? gzip.subarray(10) : new Uint8Array(), {
        status: 206,
        headers: {
          ...unknownHeaders,
          'content-range': initial
            ? `bytes 10-${gzip.length - 1}/${total}`
            : `bytes ${gzip.length}-${total - 1}/${total}`
        }
      })
    })
    await expect(download(ctx, args())).rejects.toMatchObject({
      code: 'incomplete_download',
      retryable: true
    })
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(await readFile(part())).toEqual(gzip)
    expect(await readFile(`${part()}.meta.json`, 'utf8')).toBe(metadata)
    expect(await readdir(directory)).not.toContain(filename)
  })
  it('completes bounded ranges using the total declared by GET when HEAD has no length', async () => {
    const remaining = gzipSync('second complete gzip member')
    const complete = Buffer.concat([gzip, remaining])
    const unknownHeaders = { etag: headers.etag, 'accept-ranges': 'bytes' }
    await writeFile(part(), gzip.subarray(0, 10))
    await writeFile(`${part()}.meta.json`, JSON.stringify({ ...identity, expected_size: null }))
    fetchMock
      .mockResolvedValueOnce(new Response(null, { headers: unknownHeaders }))
      .mockResolvedValueOnce(
        new Response(gzip.subarray(10), {
          status: 206,
          headers: {
            ...unknownHeaders,
            'content-range': `bytes 10-${gzip.length - 1}/${complete.length}`
          }
        })
      )
      .mockResolvedValueOnce(
        new Response(remaining, {
          status: 206,
          headers: {
            ...unknownHeaders,
            'content-range': `bytes ${gzip.length}-${complete.length - 1}/${complete.length}`
          }
        })
      )
    const result = await download(ctx, args())
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[2][1].headers.Range).toBe(`bytes=${gzip.length}-`)
    expect(result).toMatchObject({ verified_gzip: true, size_bytes: complete.length })
    expect(await readFile(String(result.saved_path))).toEqual(complete)
    expect(await readdir(directory)).toEqual([filename])
  })
  it.each(['changed', 'unknown', 'unsafe-integer'])(
    'preserves the partial when a retry has a %s range total',
    async (kind) => {
      const total = gzip.length + 47
      const nextTotal =
        kind === 'changed' ? total + 1 : kind === 'unknown' ? '*' : '9007199254740992'
      const unknownHeaders = { etag: headers.etag, 'accept-ranges': 'bytes' }
      await writeFile(part(), gzip.subarray(0, 10))
      await writeFile(`${part()}.meta.json`, JSON.stringify({ ...identity, expected_size: null }))
      fetchMock
        .mockResolvedValueOnce(new Response(null, { headers: unknownHeaders }))
        .mockResolvedValueOnce(
          new Response(gzip.subarray(10), {
            status: 206,
            headers: {
              ...unknownHeaders,
              'content-range': `bytes 10-${gzip.length - 1}/${total}`
            }
          })
        )
        .mockResolvedValueOnce(
          new Response('must not append', {
            status: 206,
            headers: {
              ...unknownHeaders,
              'content-range': `bytes ${gzip.length}-${total - 1}/${nextTotal}`
            }
          })
        )
      await expect(download(ctx, args())).rejects.toMatchObject({ code: 'unsafe_resume_response' })
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(await readFile(part())).toEqual(gzip)
      expect(await readdir(directory)).not.toContain(filename)
    }
  )
  it('rejects unknown filenames before creating files or requesting data', async () => {
    await expect(download(ctx, { ...args(), filename: '../outside.tar.gz' })).rejects.toMatchObject(
      { code: 'invalid_arguments' }
    )
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await readdir(directory)).toEqual([])
  })
})
