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
  it.each([false, true])(
    'preserves the original backup and bounds diagnostics (long: %s)',
    async (long) => {
      renameFailure.message =
        'simulated Windows sharing violation' +
        (long ? ' password="CLEANUP_SECRET"\n' + 'y'.repeat(20_000) + '\ncleanup tail' : '')
      storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-rollback-'))
      const repository = new ArtifactRepository(storageRoot)
      const request = {
        projectId: 'project-1',
        sessionId: 'session-1',
        runId: 'run-1',
        filename: 'result.txt',
        source: { kind: 'inline' as const, content: 'original', encoding: 'utf8' as const }
      }
      const original = await repository.writePendingFile(request)

      const failure = await repository
        .withPendingFileTransaction(
          {
            ...request,
            source: { kind: 'inline', content: 'replacement', encoding: 'utf8' }
          },
          {},
          async () => {
            throw new Error(
              'durable Version write failed' +
                (long ? ' password="PRIMARY_SECRET"\n' + 'x'.repeat(20_000) + '\nprimary tail' : '')
            )
          }
        )
        .then(
          () => {
            throw new Error('Expected rollback failure')
          },
          (error: Error) => error
        )
      for (const fact of [
        'durable Version write failed',
        'simulated Windows sharing violation',
        'publication was not confirmed',
        'backup retained'
      ]) {
        expect(failure.message).toContain(fact)
      }

      const directory = dirname(original.path)
      const backup = (await readdir(directory)).find(
        (entry) => entry.startsWith('result.txt.') && entry.endsWith('.backup')
      )
      expect(backup).toBeDefined()
      expect(failure.message).toContain(join(directory, backup!))
      if (long) {
        expect(failure.message).not.toMatch(/PRIMARY_SECRET|CLEANUP_SECRET/)
        expect(failure.message).toContain('primary tail')
        expect(failure.message).toContain('cleanup tail')
        expect(failure.message).toContain('[diagnostic truncated]')
        expect(failure.message.length).toBeLessThan(4_000)
      }
      await expect(readFile(join(directory, backup!), 'utf8')).resolves.toBe('original')
    }
  )
})
