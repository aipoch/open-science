import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { UploadRepository } from '../uploads/repository'
import { stageUploadFixtures } from '../uploads/repository.test-utils'
import { createManagedFileReferenceResolver } from './file-reference-resolver'

let root: string | undefined

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('managed file reference resolver', () => {
  it('validates upload paths and returns trusted on-disk metadata', async () => {
    root = await mkdtemp(join(tmpdir(), 'file-reference-resolver-'))
    const uploads = new UploadRepository(root)
    const [pending] = await stageUploadFixtures(uploads, {
      files: [
        {
          name: 'study.csv',
          mimeType: 'text/csv',
          content: Buffer.from('id,value\n1,2\n').toString('base64')
        }
      ]
    })
    const [attachment] = await uploads.finalizePendingSessionUploads('session-1', [pending])
    const resolver = createManagedFileReferenceResolver({ uploads })

    const resolved = await resolver.resolve(
      { sessionId: 'session-1' },
      {
        id: attachment.id,
        name: attachment.originalName,
        path: attachment.path,
        source: 'upload',
        mimeType: attachment.mimeType
      }
    )

    expect(resolved).toMatchObject({
      absolutePath: await realpath(attachment.path),
      name: 'study.csv',
      mimeType: 'text/csv',
      size: 'id,value\n1,2\n'.length,
      allowSkillImportReference: true
    })
    expect(resolved.uri).toMatch(/^file:/u)
  })

  it('leaves linked folders unavailable until a capability-validating adapter is registered', async () => {
    const resolver = createManagedFileReferenceResolver({})

    await expect(
      resolver.resolve(
        { sessionId: 'session-1' },
        {
          id: 'linked-1',
          name: 'future.csv',
          source: 'linked-folder',
          rootId: 'root-1',
          relativePath: 'data/future.csv'
        }
      )
    ).rejects.toThrow(/not configured/i)
  })
})
