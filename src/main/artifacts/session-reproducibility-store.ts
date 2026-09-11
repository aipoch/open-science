import { join } from 'node:path'
import { lstat } from 'node:fs/promises'
import type { SessionReproducibilityBatch } from '../../shared/session-reproducibility'
import { sessionReproducibilityBatchSchema } from '../../shared/session-reproducibility'
import { assertSafePathSegment } from './storage-access'
import { canonicalJson, sha256, type CanonicalJson } from './provenance-canonical'
import { readDurableJsonFile, writeDurableJsonFile } from '../storage/durable-json-file'

type Scope = Pick<SessionReproducibilityBatch, 'projectId' | 'appSessionId'>
export class SessionReproducibilityStore {
  constructor(private readonly root: string) {}
  private async path(scope: Scope): Promise<string> {
    let path = this.root
    for (const segment of [
      'artifacts',
      assertSafePathSegment(scope.projectId),
      assertSafePathSegment(scope.appSessionId),
      '.reproducibility'
    ]) {
      path = join(path, segment)
      const metadata = await lstat(path).catch((error) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink()))
        throw new Error('Invalid Session check directory.')
    }
    const file = join(path, 'latest.json')
    const metadata = await lstat(file).catch((error) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (metadata && (!metadata.isFile() || metadata.isSymbolicLink()))
      throw new Error('Invalid Session check file.')
    return file
  }
  async save(value: SessionReproducibilityBatch): Promise<void> {
    const state = sessionReproducibilityBatchSchema.parse(value)
    const serialized = canonicalJson(state as CanonicalJson)
    await writeDurableJsonFile(
      await this.path(state),
      JSON.stringify({ schemaVersion: 1, state, checksum: sha256(serialized) })
    )
  }
  async load(scope: Scope): Promise<SessionReproducibilityBatch | undefined> {
    const result = await readDurableJsonFile(
      await this.path(scope),
      (text) => {
        const record = JSON.parse(text)
        if (
          record.schemaVersion !== 1 ||
          Object.keys(record).sort().join(',') !== 'checksum,schemaVersion,state'
        )
          throw new Error('Invalid Session check record.')
        const state = sessionReproducibilityBatchSchema.parse(record.state)
        if (
          state.projectId !== scope.projectId ||
          state.appSessionId !== scope.appSessionId ||
          sha256(canonicalJson(state as CanonicalJson)) !== record.checksum
        )
          throw new Error('Session check identity mismatch.')
        return state
      },
      undefined,
      { maxBytes: 1024 * 1024 }
    )
    return result.status === 'found' ? result.value : undefined
  }
}
