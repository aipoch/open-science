import { createHash } from 'node:crypto'
import { open, realpath } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import type { NotebookAnalysisRun } from './run-contract'
import type { FileGeneration } from './serialized-file-provenance'
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
// Read only the small, checksummed evidence manifest. Never open or deserialize serialized data.
export const readGenerations = async (
  storageRoot: string,
  run: NotebookAnalysisRun,
  budget: { remaining: number }
): Promise<FileGeneration[]> => {
  const ref = run.fileEvidence
  if (
    !ref?.storageKey ||
    !ref.evidenceId ||
    !digest(ref.checksum) ||
    ref.activityKind !== 'notebook-run' ||
    ref.activityId !== run.runId
  )
    return []
  try {
    const root = await realpath(storageRoot)
    const path = await realpath(resolve(root, ref.storageKey))
    const subpath = relative(root, path)
    if (
      !subpath ||
      subpath.startsWith('..') ||
      isAbsolute(subpath) ||
      basename(path) !== 'evidence.json'
    )
      return []
    const file = await open(path, 'r')
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 1024 * 1024 || stat.size > budget.remaining) return []
      budget.remaining -= stat.size
      const bytes = Buffer.alloc(stat.size + 1)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      if (bytesRead !== stat.size) return []
      const contents = bytes.subarray(0, bytesRead)
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
    } finally {
      await file.close()
    }
  } catch {
    return []
  }
}
