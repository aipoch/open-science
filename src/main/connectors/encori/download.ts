import { constants, createReadStream } from 'node:fs'
import { copyFile, lstat, open, readFile, realpath, rm, statfs, link } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Writable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { publishUserFile } from '../../user-file-publisher'
import type { ToolContext } from '../types'
import { BASE, outputDirectory, publicationOptions } from './client'
import { abortable, EncoriError, failure, receive, success, type Args } from './runtime'

export const BULK_TYPES = [
  'miRNA_mRNA',
  'miRNA_lncRNA',
  'miRNA_pseudogene',
  'miRNA_sncRNA',
  'miRNA_circRNA',
  'RNA_RNA',
  'RBP_mRNA',
  'RBP_lncRNA',
  'RBP_pseudogene',
  'RBP_sncRNA',
  'RBP_circRNA',
  'RBP_caRNA'
]
export const DATASETS = ['hg38', 'mm10'].flatMap((assembly) =>
  BULK_TYPES.map((data_type) => ({
    assembly,
    data_type,
    filename: `${assembly}.${data_type}.tar.gz`,
    download_url: `${BASE}/download/${assembly}.${data_type}.tar.gz`
  }))
)
type Dataset = (typeof DATASETS)[number]

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function head(ctx: ToolContext, item: Dataset): Promise<Args> {
  return receive(item.download_url, ctx, { method: 'HEAD' }, async (response) => {
    const length = response.headers.get('content-length')
    const size =
      length && /^\d+$/.test(length) && Number.isSafeInteger(Number(length)) ? Number(length) : null
    return {
      ...item,
      available: true,
      size_bytes: size,
      size_mib: size == null ? null : size / 1024 ** 2,
      etag: response.headers.get('etag'),
      last_modified: response.headers.get('last-modified'),
      accept_ranges: response.headers.get('accept-ranges'),
      content_type: response.headers.get('content-type')
    }
  })
}

export async function listDatasets(ctx: ToolContext, args: Args): Promise<Args> {
  const selected = DATASETS.filter(
    (item) =>
      (!args.assembly || args.assembly === item.assembly) &&
      (!args.data_type || args.data_type === item.data_type)
  )
  const files: Args[] = [],
    warnings: string[] = []
  for (const item of selected) {
    ctx.signal?.throwIfAborted()
    if (args.check_availability === false) {
      files.push({
        ...item,
        available: null,
        size_bytes: null,
        size_mib: null,
        etag: null,
        last_modified: null,
        accept_ranges: null,
        content_type: null
      })
      continue
    }
    try {
      files.push(await head(ctx, item))
    } catch (error) {
      ctx.signal?.throwIfAborted()
      if (!(error instanceof EncoriError)) throw error
      files.push({
        ...item,
        available: false,
        size_bytes: null,
        size_mib: null,
        etag: null,
        last_modified: null,
        accept_ranges: null,
        content_type: null,
        error: error.asResult().error
      })
      warnings.push(`${item.filename}: metadata request failed.`)
    }
  }
  return {
    ...success(`${BASE}/tutorialAPI.php`),
    ok: !warnings.length,
    files,
    returned_files: files.length,
    query: {
      assembly: args.assembly ?? null,
      data_type: args.data_type ?? null,
      check_availability: args.check_availability ?? true
    },
    is_complete: true,
    result_scope: warnings.length ? 'completed_with_errors' : 'complete',
    warnings,
    completeness_note: 'All documented bulk dataset entries matching the filters are included.',
    error: warnings.length
      ? {
          code: 'partial_failure',
          message: 'Some metadata requests failed.',
          retryable: true,
          status_code: null
        }
      : null
  }
}

// Open Science owns the main-process tool dispatch. The process-local guard rejects
// overlapping writes and releases automatically on crash; no persistent lock can
// prevent recovery of a verified .part after restart.
const activeDownloads = new Set<string>()

export async function download(ctx: ToolContext, args: Args): Promise<Args> {
  const item = DATASETS.find((value) => value.filename === args.filename)
  if (!item) throw new EncoriError('invalid_arguments', 'filename must be from list_bulk_datasets.')
  const directory = await realpath(await outputDirectory(args.destination_dir, ctx.signal))
  ctx.signal?.throwIfAborted()
  const target = join(directory, item.filename),
    part = `${target}.part`,
    metadataPath = `${part}.meta.json`
  if (activeDownloads.has(target))
    throw new EncoriError('download_in_progress', 'This file is already being downloaded.')
  activeDownloads.add(target)
  try {
    if (await exists(target))
      throw new EncoriError(
        'file_exists',
        'Refusing to overwrite the destination.',
        false,
        null,
        item.download_url
      )
    const metadata = await head(ctx, item)
    const expected = typeof metadata.size_bytes === 'number' ? metadata.size_bytes : null
    const identity = {
      download_url: item.download_url,
      expected_size: expected,
      etag: metadata.etag,
      last_modified: metadata.last_modified
    }
    let offset = 0
    let hasPart = await exists(part)
    let metadataReady = false
    if (hasPart) {
      const info = await lstat(part)
      if (!info.isFile() || info.isSymbolicLink())
        throw new EncoriError('partial_file_invalid', 'Expected a regular partial file.')
      if (!(await exists(metadataPath)))
        throw new EncoriError(
          'partial_metadata_missing',
          'Keep and inspect the legacy .part: identity metadata is missing.'
        )
      offset = info.size
      if (expected != null && offset > expected)
        throw new EncoriError('partial_file_invalid', 'Partial file exceeds official size.')
    }
    if (hasPart || (await exists(metadataPath))) {
      const metaInfo = await lstat(metadataPath)
      if (!metaInfo.isFile() || metaInfo.isSymbolicLink() || metaInfo.size > 4096)
        throw new EncoriError('download_metadata_error', 'Invalid partial metadata file.')
      let saved: Args
      try {
        saved = JSON.parse(await readFile(metadataPath, 'utf8')) as Args
      } catch {
        throw new EncoriError(
          'download_metadata_error',
          'Unable to read partial identity metadata.'
        )
      }
      const hasReceipt =
        saved &&
        typeof saved === 'object' &&
        ['owner', 'schema_version', 'partial_path'].some((key) => Object.hasOwn(saved, key))
      if (
        (!hasPart || hasReceipt) &&
        (saved?.owner !== 'open-science.encori.download' ||
          saved.schema_version !== 1 ||
          saved.partial_path !== part)
      )
        throw new EncoriError(
          hasPart ? 'download_metadata_error' : 'orphan_download_metadata',
          'Preserve and inspect metadata whose owner, version or partial path does not match.'
        )
      if (
        !saved ||
        typeof saved !== 'object' ||
        Object.entries(identity).some(([key, value]) => saved[key] !== value)
      )
        throw new EncoriError(
          'remote_file_changed',
          'Cannot safely resume a changed official file.'
        )
      metadataReady = true
    }
    if (expected != null) {
      const fs = await statfs(directory)
      if (fs.bavail * fs.bsize < expected - offset + Math.max(64 * 1024 ** 2, expected * 0.05))
        throw new EncoriError(
          'insufficient_disk_space',
          'Not enough space for the remaining download and reserve.'
        )
    }
    let resumedFrom = offset
    // HEAD may omit the size. Retain any numeric range total across retries,
    // without changing the on-disk identity recorded from HEAD.
    let expectedTotal = expected
    if (expected == null || offset < expected) {
      await receive(
        item.download_url,
        ctx,
        () => {
          const headers: Record<string, string> = {}
          if (offset) {
            const validator =
              typeof metadata.etag === 'string' && !metadata.etag.startsWith('W/')
                ? metadata.etag
                : metadata.last_modified
            if (!validator || !String(metadata.accept_ranges).toLowerCase().includes('bytes'))
              throw new EncoriError(
                'resume_not_supported',
                'A range validator is required to safely resume.'
              )
            headers.Range = `bytes=${offset}-`
            headers['If-Range'] = String(validator)
            resumedFrom = Math.max(resumedFrom, offset)
          }
          return { headers }
        },
        async (response, { signal, touch }) => {
          let rangeLength: number | null = null
          if (offset) {
            const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(
              response.headers.get('content-range') ?? ''
            )
            const rangeEnd = Number(range?.[2])
            const rangeTotal = range && range[3] !== '*' ? Number(range[3]) : null
            if (
              response.status !== 206 ||
              !range ||
              Number(range[1]) !== offset ||
              !Number.isSafeInteger(rangeEnd) ||
              rangeEnd < offset ||
              (expectedTotal != null && range[3] !== String(expectedTotal)) ||
              (rangeTotal != null && (!Number.isSafeInteger(rangeTotal) || rangeEnd >= rangeTotal))
            )
              throw new EncoriError(
                'unsafe_resume_response',
                'No data appended: the range response does not match the partial file.'
              )
            rangeLength = rangeEnd - offset + 1
            if (rangeTotal != null) expectedTotal = rangeTotal
          } else if (response.status !== 200)
            throw new EncoriError('unexpected_partial_response', 'No range was requested.')
          for (const [key, header] of [
            ['etag', 'etag'],
            ['last_modified', 'last-modified']
          ] as const) {
            const value = response.headers.get(header)
            if (value && identity[key] && value !== identity[key])
              throw new EncoriError('remote_file_changed', 'GET identity differs from HEAD.')
          }
          if (!response.body)
            throw new EncoriError('incomplete_download', 'Missing response body.', true)
          if (!metadataReady) {
            await publishUserFile(
              metadataPath,
              async (temporary) => {
                signal.throwIfAborted()
                const meta = await open(temporary, 'wx')
                try {
                  await meta.writeFile(
                    JSON.stringify({
                      ...identity,
                      owner: 'open-science.encori.download',
                      schema_version: 1,
                      partial_path: part
                    })
                  )
                } finally {
                  await meta.close()
                }
              },
              publicationOptions(signal)
            )
            metadataReady = true
          }
          signal.throwIfAborted()
          const file = await open(
            part,
            hasPart ? constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW : 'wx'
          )
          hasPart = true
          try {
            if ((await file.stat()).size !== offset)
              throw new EncoriError(
                'partial_file_invalid',
                'Partial file changed during this call.'
              )
            const startOffset = offset
            const reader = response.body.getReader()
            const cancel = (): void => {
              void reader.cancel(signal.reason).catch(() => undefined)
            }
            signal.addEventListener('abort', cancel, { once: true })
            try {
              for (;;) {
                let chunk: ReadableStreamReadResult<Uint8Array>
                try {
                  chunk = await abortable(reader.read(), signal)
                } catch {
                  if (signal.aborted) throw signal.reason
                  throw new EncoriError(
                    'network_error',
                    'Download interrupted; the partial file is retained.',
                    true
                  )
                }
                signal.throwIfAborted()
                if (chunk.done) break
                touch()
                if (
                  (expectedTotal != null && offset + chunk.value.length > expectedTotal) ||
                  (rangeLength != null && offset - startOffset + chunk.value.length > rangeLength)
                )
                  throw new EncoriError(
                    'download_size_mismatch',
                    'Official size or range exceeded.'
                  )
                let written = 0
                while (written < chunk.value.length) {
                  signal.throwIfAborted()
                  const result = await file.write(
                    chunk.value,
                    written,
                    chunk.value.length - written
                  )
                  if (!result.bytesWritten)
                    throw new EncoriError('download_failed', 'No bytes written.')
                  written += result.bytesWritten
                  offset += result.bytesWritten
                }
              }
            } finally {
              signal.removeEventListener('abort', cancel)
              void reader.cancel().catch(() => undefined)
              reader.releaseLock()
            }
            if (
              (expectedTotal != null && offset !== expectedTotal) ||
              (rangeLength != null && offset - startOffset !== rangeLength)
            )
              throw new EncoriError(
                'incomplete_download',
                `Incomplete download: ${offset}/${expectedTotal ?? 'unknown'} bytes. Retry the same filename and directory to resume.`,
                true
              )
          } finally {
            try {
              await file.sync()
            } finally {
              await file.close()
            }
          }
        }
      )
    }
    try {
      await pipeline(
        createReadStream(part),
        createGunzip(),
        new Writable({
          write(_chunk, _encoding, done) {
            done()
          }
        }),
        { signal: ctx.signal }
      )
    } catch {
      ctx.signal?.throwIfAborted()
      throw new EncoriError(
        'gzip_verification_failed',
        'gzip integrity check failed; the partial file is retained.'
      )
    }
    ctx.signal?.throwIfAborted()
    await publishUserFile(
      target,
      async (temporary) => {
        ctx.signal?.throwIfAborted()
        try {
          await link(part, temporary)
        } catch (error) {
          if (
            !['EACCES', 'EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(
              String((error as NodeJS.ErrnoException).code)
            )
          )
            throw error
          await copyFile(part, temporary, constants.COPYFILE_EXCL)
        }
        ctx.signal?.throwIfAborted()
      },
      publicationOptions(ctx.signal)
    )
    const warnings: string[] = []
    for (const path of [part, metadataPath]) {
      await rm(path).catch(() =>
        warnings.push(`Verified file saved, but cleanup failed for ${path}.`)
      )
    }
    return {
      ...success(item.download_url),
      saved_path: target,
      filename: item.filename,
      size_bytes: offset,
      size_mib: offset / 1024 ** 2,
      resumed: resumedFrom > 0,
      resumed_from_bytes: resumedFrom,
      verified_gzip: true,
      warnings
    }
  } catch (error) {
    ctx.signal?.throwIfAborted()
    throw failure(error, item.download_url)
  } finally {
    activeDownloads.delete(target)
  }
}
