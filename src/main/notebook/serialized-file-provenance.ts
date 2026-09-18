import { createHash } from 'node:crypto'
import { open, realpath } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, posix } from 'node:path'
import type { NotebookRunRecord } from '../../shared/notebook'
import type {
  NotebookRunDependencyFacts,
  NotebookSerializedValue,
  NotebookSourceFileAccessContext
} from './dependency-analysis-types'

type Generation = { path: string; checksum: string; relation: string }
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export const serializedSourcePath = (path: string): string | undefined => {
  if (
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').includes('..') ||
    path.startsWith('/') ||
    /^[a-z]+:/i.test(path)
  )
    return undefined
  const normalized = posix.normalize(path)
  return normalized === '..' || normalized.startsWith('../') ? undefined : normalized
}

// Read only the small, checksummed evidence manifest. Never open or deserialize serialized data.
const readGenerations = async (
  storageRoot: string,
  run: NotebookRunRecord,
  budget: { remaining: number }
): Promise<Generation[]> => {
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

export const verifiedSerializedValues = (
  files: NonNullable<NotebookSourceFileAccessContext['serializedValueFiles']>,
  generations: readonly { path: string; checksum: string }[],
  executionRelativeRoot = 'data'
): NotebookSerializedValue[] =>
  files.flatMap((file) => {
    if (!generations.some((g) => g.path === file.path && g.checksum === file.checksum)) return []
    const path = posix.relative(executionRelativeRoot, file.path)
    return serializedSourcePath(path)
      ? [{ path, format: file.format, valueType: file.valueType }]
      : []
  })

export const serializedFileContext = async (
  storageRoot: string,
  runs: readonly NotebookRunRecord[],
  factsFor: (run: NotebookRunRecord) => NotebookRunDependencyFacts | undefined,
  currentRunId: string,
  context?: NotebookSourceFileAccessContext
): Promise<NotebookSourceFileAccessContext | undefined> => {
  const files: NonNullable<NotebookSourceFileAccessContext['serializedValueFiles']> = []
  const budget = { remaining: 8 * 1024 * 1024 }
  const currentIndex = runs.findIndex((run) => run.runId === currentRunId)
  const preceding = currentIndex < 0 ? runs : runs.slice(0, currentIndex)
  let inspected = 0
  // The source proof belongs to a file generation, not a kernel namespace. It can bridge epochs.
  for (const run of [...preceding].reverse()) {
    const facts = factsFor(run)
    if (
      !['r', 'python'].includes(run.kernelKind) ||
      run.status !== 'completed' ||
      run.fileEvidence?.state !== 'available' ||
      run.fileEvidence.writerAttribution !== 'complete' ||
      !facts?.serializedValueWrites?.length ||
      (facts.state === 'unknown' && facts.reasons.some((reason) => reason !== 'external-state'))
    )
      continue
    if (inspected++ >= 128 || budget.remaining === 0 || files.length >= 128) break
    const writtenPaths = new Map<string, NotebookSerializedValue>(
      facts.serializedValueWrites.flatMap((value) => {
        const normalized = serializedSourcePath(value.path)
        return normalized ? [[`data/${normalized}`, value] as const] : []
      })
    )
    for (const generation of await readGenerations(storageRoot, run, budget)) {
      if (
        ['created', 'modified'].includes(generation.relation) &&
        writtenPaths.has(generation.path)
      )
        files.push({
          ...writtenPaths.get(generation.path)!,
          path: generation.path,
          checksum: generation.checksum
        })
    }
    if (files.length > 128) files.length = 128
  }
  if (!files.length) return context
  const current = runs.find((run) => run.runId === currentRunId)
  const initial = current
    ? (await readGenerations(storageRoot, current, { remaining: 1024 * 1024 })).filter(
        (g) => g.relation === 'present-before'
      )
    : []
  return {
    ...(context ?? { staticStrings: [], staticCollections: [], localFileWrappers: [] }),
    serializedValueFiles: files,
    verifiedSerializedValues: verifiedSerializedValues(files, initial)
  }
}

export const serializedValueDescriptors = (
  value: unknown
): NotebookSerializedValue[] | undefined => {
  if (!Array.isArray(value) || value.length > 128) return undefined
  return value.every(
    (entry) =>
      entry &&
      typeof entry.path === 'string' &&
      entry.path.length <= 4096 &&
      serializedSourcePath(entry.path) &&
      ((entry.format === 'npy' && entry.valueType === 'numpy.ndarray') ||
        (['rds', 'qs'].includes(entry.format) && entry.valueType === 'r-value') ||
        (['python-pickle', 'joblib'].includes(entry.format) &&
          ['pandas.DataFrame', 'pandas.Series', 'numpy.ndarray'].includes(entry.valueType)))
  )
    ? value
    : undefined
}
