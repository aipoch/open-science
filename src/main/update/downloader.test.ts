import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { downloadInstaller } from './downloader'

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

let dir = ''
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

describe('downloadInstaller', () => {
  it('writes to the target path, verifies sha256, and reports progress', async () => {
    dir = await mkdtemp(join(tmpdir(), 'upd-'))
    const target = join(dir, 'open-science-0.3.0-mac-arm64.dmg')
    const body = Buffer.from('installer-bytes')
    const progresses: { percent: number; transferred: number; total: number }[] = []
    const fetchImpl = (() =>
      Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch

    const path = await downloadInstaller(
      {
        url: 'https://cdn/open-science-0.3.0-mac-arm64.dmg',
        size: body.byteLength,
        sha256: sha256(body)
      },
      target,
      { fetchImpl, onProgress: (p) => progresses.push(p) }
    )

    expect(path).toBe(target)
    expect(await readFile(path)).toEqual(body)
    expect(progresses.at(-1)).toEqual({
      percent: 100,
      transferred: body.byteLength,
      total: body.byteLength
    })
  })

  it('deletes the file and throws on checksum mismatch', async () => {
    dir = await mkdtemp(join(tmpdir(), 'upd-'))
    const target = join(dir, 'x.dmg')
    const body = Buffer.from('installer-bytes')
    const fetchImpl = (() =>
      Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch

    await expect(
      downloadInstaller(
        { url: 'https://cdn/x.dmg', size: body.byteLength, sha256: 'deadbeef' },
        target,
        {
          fetchImpl
        }
      )
    ).rejects.toThrow('Checksum mismatch')
    expect(existsSync(target)).toBe(false)
  })

  it('aborts the download and cleans up the partial file when the signal fires', async () => {
    dir = await mkdtemp(join(tmpdir(), 'upd-'))
    const target = join(dir, 'z.dmg')
    const controller = new AbortController()
    // Mimic real fetch: emit one chunk, then error the stream when the abort signal fires so the
    // reader's next read rejects.
    const fetchImpl = ((_url: unknown, init?: { signal?: AbortSignal }) => {
      const body = new ReadableStream({
        start(streamController) {
          streamController.enqueue(new Uint8Array([1, 2, 3]))
          init?.signal?.addEventListener('abort', () =>
            streamController.error(new DOMException('The user aborted a request.', 'AbortError'))
          )
        }
      })
      return Promise.resolve(new Response(body, { status: 200 }))
    }) as unknown as typeof fetch

    const promise = downloadInstaller(
      { url: 'https://cdn/z.dmg', size: 100, sha256: 'irrelevant' },
      target,
      { fetchImpl, signal: controller.signal }
    )
    controller.abort()

    await expect(promise).rejects.toThrow()
    expect(existsSync(target)).toBe(false)
  })

  it('rejects and cleans up the partial file on a mid-stream error', async () => {
    dir = await mkdtemp(join(tmpdir(), 'upd-'))
    const target = join(dir, 'y.dmg')
    const erroringBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        controller.error(new Error('network drop'))
      }
    })
    const fetchImpl = (() =>
      Promise.resolve(new Response(erroringBody, { status: 200 }))) as unknown as typeof fetch

    await expect(
      downloadInstaller({ url: 'https://cdn/y.dmg', size: 100, sha256: 'irrelevant' }, target, {
        fetchImpl
      })
    ).rejects.toThrow()
    expect(existsSync(target)).toBe(false)
  })
})
