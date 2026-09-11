import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ReadArtifactPreviewRequest } from '../shared/artifacts'
import {
  readBoundedManagedFilePreview,
  waitForManagedFilePublication
} from './managed-file-preview'

describe('readBoundedManagedFilePreview', () => {
  let directory: string | undefined

  afterEach(async () => {
    vi.useRealTimers()
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it('reads a later bounded page from its byte offset', async () => {
    directory = await mkdtemp(join(tmpdir(), 'open-science-paged-preview-'))
    const filePath = join(directory, 'notes.txt')
    await writeFile(filePath, 'abcdef', 'utf8')

    const first = await readBoundedManagedFilePreview(
      filePath,
      { path: filePath, maxBytes: 3, encoding: 'utf8', offset: 0 },
      'Invalid encoding.'
    )
    const second = await readBoundedManagedFilePreview(
      filePath,
      { path: filePath, maxBytes: 3, encoding: 'utf8', offset: 3 } as ReadArtifactPreviewRequest,
      'Invalid encoding.'
    )

    expect(first).toMatchObject({ content: 'abc', offset: 0, nextOffset: 3, truncated: true })
    expect(second).toMatchObject({ content: 'def', offset: 3, truncated: false })
    expect(second).not.toHaveProperty('nextOffset')
  })

  it('keeps a UTF-8 character intact across page boundaries', async () => {
    directory = await mkdtemp(join(tmpdir(), 'open-science-paged-preview-'))
    const filePath = join(directory, 'unicode.txt')
    await writeFile(filePath, 'a你b', 'utf8')

    const first = await readBoundedManagedFilePreview(
      filePath,
      { path: filePath, maxBytes: 3, encoding: 'utf8', offset: 0 },
      'Invalid encoding.'
    )
    const second = await readBoundedManagedFilePreview(
      filePath,
      {
        path: filePath,
        maxBytes: 3,
        encoding: 'utf8',
        offset: first.nextOffset
      } as ReadArtifactPreviewRequest,
      'Invalid encoding.'
    )

    expect(first.content).toBe('a你')
    expect(`${first.content}${second.content}`).toBe('a你b')
    expect(`${first.content}${second.content}`).not.toContain('\uFFFD')
  })
})

describe('waitForManagedFilePublication', () => {
  afterEach(() => vi.useRealTimers())

  it('stops retrying and preserves the publication error after the bounded wait', async () => {
    vi.useFakeTimers()
    const publicationPending = Object.assign(new Error('Managed file has no published version.'), {
      code: 'VERSION_NOT_FOUND'
    })
    const openManagedFile = vi.fn().mockRejectedValue(publicationPending)

    const result = waitForManagedFilePublication(openManagedFile)
    const rejection = expect(result).rejects.toBe(publicationPending)
    await vi.runAllTimersAsync()

    await rejection
    expect(openManagedFile).toHaveBeenCalledTimes(6)
  })

  it('does not retry an unrelated missing Version', async () => {
    const missingVersion = Object.assign(new Error('Managed file version was not found.'), {
      code: 'VERSION_NOT_FOUND'
    })
    const openManagedFile = vi.fn().mockRejectedValue(missingVersion)

    await expect(waitForManagedFilePublication(openManagedFile)).rejects.toBe(missingVersion)
    expect(openManagedFile).toHaveBeenCalledOnce()
  })
})
