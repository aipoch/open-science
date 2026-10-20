import { posix } from 'node:path'
import type { NotebookRunRecord } from './run-contract'
import type {
  NotebookRunDependencyFacts,
  NotebookSerializedValue,
  NotebookSourceFileAccessContext
} from './dependency-analysis-types'

/** Paths share a caller-defined namespace; executionRelativeRoot locates source-relative paths. */
export type FileGeneration = { path: string; checksum: string; relation: string }
export type ReadFileGenerations = (
  run: NotebookRunRecord,
  budget: { remaining: number }
) => Promise<FileGeneration[]>
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

export const verifiedSerializedValues = (
  files: NonNullable<NotebookSourceFileAccessContext['serializedValueFiles']>,
  generations: readonly { path: string; checksum: string }[],
  executionRelativeRoot = '.'
): NotebookSerializedValue[] =>
  files.flatMap((file) => {
    if (!generations.some((g) => g.path === file.path && g.checksum === file.checksum)) return []
    const path = posix.relative(executionRelativeRoot, file.path)
    return serializedSourcePath(path)
      ? [{ path, format: file.format, valueType: file.valueType }]
      : []
  })

export const serializedFileContext = async (
  readGenerations: ReadFileGenerations,
  runs: readonly NotebookRunRecord[],
  factsFor: (run: NotebookRunRecord) => NotebookRunDependencyFacts | undefined,
  currentRunId: string,
  context?: NotebookSourceFileAccessContext,
  executionRelativeRoot = '.'
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
        return normalized ? [[posix.join(executionRelativeRoot, normalized), value] as const] : []
      })
    )
    for (const generation of await readGenerations(run, budget)) {
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
    ? (await readGenerations(current, { remaining: 1024 * 1024 })).filter(
        (g) => g.relation === 'present-before'
      )
    : []
  return {
    ...(context ?? { staticStrings: [], staticCollections: [], localFileWrappers: [] }),
    serializedValueFiles: files,
    verifiedSerializedValues: verifiedSerializedValues(files, initial, executionRelativeRoot)
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
          [
            'pandas.DataFrame',
            'pandas.Series',
            'numpy.ndarray',
            'sklearn.preprocessing.StandardScaler',
            'sklearn.decomposition.PCA',
            'sklearn.linear_model.LinearRegression'
          ].includes(entry.valueType)))
  )
    ? value
    : undefined
}
