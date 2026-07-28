import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const renameFailure = new Error('simulated Windows sharing violation')

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: vi.fn(async (source: string, target: string) => {
      if (source.endsWith('.backup') && basename(target) === 'result.txt') {
        throw renameFailure
      }
      return actual.rename(source, target)
    })
  }
})

import { ArtifactRepository } from './repository'

let storageRoot: string | undefined

afterEach(async () => {
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

describe('ArtifactRepository pending-file rollback', () => {
  it('preserves the original backup when restoring it fails', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-rollback-'))
    const repository = new ArtifactRepository(storageRoot)
    const request = {
      projectName: 'project-1',
      sessionId: 'session-1',
      runId: 'run-1',
      filename: 'result.txt',
      source: { kind: 'inline' as const, content: 'original', encoding: 'utf8' as const }
    }
    const original = await repository.writePendingFile(request)

    await expect(
      repository.withPendingFileTransaction(
        {
          ...request,
          source: { kind: 'inline', content: 'replacement', encoding: 'utf8' }
        },
        {},
        async () => {
          throw new Error('durable Version write failed')
        }
      )
    ).rejects.toThrow(renameFailure.message)

    const directory = dirname(original.path)
    const backup = (await readdir(directory)).find(
      (entry) => entry.startsWith('result.txt.') && entry.endsWith('.backup')
    )
    expect(backup).toBeDefined()
    await expect(readFile(join(directory, backup!), 'utf8')).resolves.toBe('original')
  })
})
