import { createHash } from 'node:crypto'
import { open, realpath } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import type { FileGeneration } from '@aipoch/notebook-analysis'
import { readNativeEvidence } from '../artifacts/execution-evidence-log'
import type { NotebookRunRecord } from '../../shared/notebook'
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const readManifest = async (
  storageRoot: string,
  storageKey: string,
  checksum: string,
  budget: { remaining: number }
): Promise<Buffer | undefined> => {
  const root = await realpath(storageRoot)
  let path: string
  try {
    path = await realpath(resolve(root, storageKey))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const bytes = await readNativeEvidence(
      root,
      storageKey,
      checksum,
      Math.min(1024 * 1024, budget.remaining)
    )
    budget.remaining -= bytes.length
    return bytes
  }
  const subpath = relative(root, path)
  if (
    !subpath ||
    subpath.startsWith('..') ||
    isAbsolute(subpath) ||
    basename(path) !== 'evidence.json'
  )
    return undefined
  const file = await open(path, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 1024 * 1024 || stat.size > budget.remaining) return undefined
    budget.remaining -= stat.size
    const bytes = Buffer.alloc(stat.size + 1)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead !== stat.size) return undefined
    return bytes.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

// Read only the small, checksummed evidence manifest. Never open or deserialize serialized data.
export const readNotebookFileGenerations = async (
  storageRoot: string,
  run: { runId: string; fileEvidence?: unknown },
  budget: { remaining: number }
): Promise<FileGeneration[]> => {
  const ref = run.fileEvidence as NotebookRunRecord['fileEvidence']
  if (
    !ref?.storageKey ||
    !ref.evidenceId ||
    !digest(ref.checksum) ||
    ref.activityKind !== 'notebook-run' ||
    ref.activityId !== run.runId
  )
    return []
  try {
    const contents = await readManifest(storageRoot, ref.storageKey, ref.checksum, budget)
    if (!contents) return []
    if (createHash('sha256').update(contents).digest('hex') !== ref.checksum) return []
    const value = JSON.parse(contents.toString('utf8'))
    if (
      value.schemaVersion !== 1 ||
      value.activityId !== run.runId ||
      value.evidenceId !== ref.evidenceId ||
      value.activityKind !== 'notebook-run' ||
      !Array.isArray(value.relations) ||
      value.relations.length > 4096
    )
      return []
    return value.relations.flatMap(
      (item: {
        relativePath?: unknown
        relation?: unknown
        generation?: { relativePath?: unknown; checksum?: unknown }
      }) =>
        typeof item?.relativePath === 'string' &&
        typeof item.relation === 'string' &&
        digest(item.generation?.checksum) &&
        item.generation?.relativePath === item.relativePath
          ? [
              {
                path: item.relativePath,
                checksum: item.generation.checksum,
                relation: item.relation
              }
            ]
          : []
    )
  } catch {
    return []
  }
}
