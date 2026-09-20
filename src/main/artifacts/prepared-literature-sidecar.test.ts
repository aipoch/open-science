import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ARTIFACT_LITERATURE_SIDECAR_SUFFIX } from '../../shared/artifact-literature'
import { PendingRequestBudget } from '../resource-budget'
import { readPreparedLiteratureSidecar } from './prepared-literature-sidecar'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const fixture = async (): Promise<{ root: string; path: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-sidecar-'))
  roots.push(root)
  const path = join(root, 'report.zip')
  await writeFile(path, 'source')
  await writeFile(path + ARTIFACT_LITERATURE_SIDECAR_SUFFIX, ' '.repeat(256 * 1024) + '{}')
  return { root, path }
}

describe('prepared literature bounded reads', () => {
  it('aborts during a real streamed read before parsing or retaining the rest of the file', async () => {
    const { root, path } = await fixture()
    const controller = new AbortController()
    let bytes = 0
    await expect(
      readPreparedLiteratureSidecar({ kind: 'localPath', path }, [root], [], {
        signal: controller.signal,
        onBytes: (count) => {
          bytes += count
          controller.abort()
        }
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(bytes).toBeGreaterThan(0)
    expect(bytes).toBeLessThan(256 * 1024)
  })

  it('charges derived metadata to the existing admission lease and releases it on failure', async () => {
    const { root, path } = await fixture()
    const budget = new PendingRequestBudget()
    const admission = budget.acquire('session')
    admission.addBytes(128 * 1024 ** 2 - 1)
    await expect(
      readPreparedLiteratureSidecar({ kind: 'localPath', path }, [root], [], {
        onBytes: admission.addBytes
      })
    ).rejects.toThrow('ARTIFACT_SAVE_RESOURCE_LIMIT')
    admission.release()
    const next = budget.acquire('session')
    expect(() => next.addBytes(128 * 1024 ** 2)).not.toThrow()
    next.release()
  })
})
