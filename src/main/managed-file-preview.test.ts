import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ReadArtifactPreviewRequest } from '../shared/artifacts'
import { readBoundedManagedFilePreview } from './managed-file-preview'

describe('readBoundedManagedFilePreview', () => {
  let directory: string | undefined

  afterEach(async () => {
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
