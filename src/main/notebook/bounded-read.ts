import {
  NOTEBOOK_READ_CHUNK_CHARACTERS,
  NOTEBOOK_READ_PAGE_BYTES,
  type NotebookContentChunk,
  type NotebookContentRead,
  type NotebookRunReadReference,
  type NotebookRunRecord,
  type NotebookSessionState,
  type NotebookSessionStateRequest
} from '../../shared/notebook'

// This is deliberately a display projection, not an edited durable record. Stable identities,
// execution state and provenance remain exact. Large source/output and evidence are accessible in
// the content reader; they are not replicated into every list row.
export const summarizeNotebookRun = (
  run: NotebookRunRecord,
  reference: NotebookRunReadReference
): NotebookRunRecord => ({
  runId: run.runId,
  cellId: run.cellId,
  source: run.source,
  kernelKind: run.kernelKind,
  status: run.status,
  startedAt: run.startedAt,
  endedAt: run.endedAt,
  executionCount: run.executionCount,
  executionMode: run.executionMode,
  inputKind: run.inputKind,
  environment: run.environment,
  cwdBefore: run.cwdBefore,
  cwdAfter: run.cwdAfter,
  rootFrameId: run.rootFrameId,
  agentFrameId: run.agentFrameId,
  messageBranchId: run.messageBranchId,
  runtimeSegmentId: run.runtimeSegmentId,
  promptMessageId: run.promptMessageId,
  executionInvocationId: run.executionInvocationId,
  cancellationRequestedAt: run.cancellationRequestedAt,
  kernelDispatched: run.kernelDispatched,
  interruptionReason: run.interruptionReason,
  exitCode: run.exitCode,
  shellRuntimeStatus: run.shellRuntimeStatus,
  shellErrorCode: run.shellErrorCode,
  truncated: run.truncated,
  environmentCapture: run.environmentCapture,
  environmentManifestChecksum: run.environmentManifestChecksum,
  kernelEpochId: run.kernelEpochId,
  helperEvidenceStatus: run.helperEvidenceStatus,
  script: run.script.slice(0, 1024),
  text: {
    stdout: run.text.stdout.slice(0, 512),
    stderr: run.text.stderr.slice(0, 512),
    traceback: run.text.traceback.slice(0, 512),
    plain: []
  },
  outputs: [],
  inputFiles: run.inputFiles?.slice(0, 16).map((input) => {
    const result = { ...input } as Partial<typeof input>
    delete result.storageKey
    return result as typeof input
  }),
  workingFiles: run.workingFiles.slice(0, 16),
  contentRead: {
    ...reference,
    inputFileCount: run.inputFiles?.length ?? 0,
    metadataPart:
      1 +
      [run.text.stdout, run.text.stderr, run.text.traceback].filter(Boolean).length +
      (run.text.plain?.length ?? 0)
  }
})

// JSON values are encoded incrementally, including very large imported strings. No call encodes
// a full output or Run. The stack is proportional to document depth, not historical output size.
function* jsonFragments(value: unknown, omitStorageKeys = false): Generator<string> {
  if (typeof value === 'string') {
    yield '"'
    for (let offset = 0; offset < value.length;) {
      let end = Math.min(offset + 4096, value.length)
      if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--
      yield JSON.stringify(value.slice(offset, end)).slice(1, -1)
      offset = end
    }
    yield '"'
  } else if (Array.isArray(value)) {
    yield '['
    for (let index = 0; index < value.length; index++) {
      if (index) yield ','
      yield* jsonFragments(value[index], omitStorageKeys)
    }
    yield ']'
  } else if (value && typeof value === 'object') {
    yield '{'
    let first = true
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue
      if (omitStorageKeys && key === 'storageKey') continue
      const entry = (value as Record<string, unknown>)[key]
      if (entry === undefined) continue
      if (!first) yield ','
      first = false
      yield* jsonFragments(key)
      yield ':'
      yield* jsonFragments(entry, omitStorageKeys)
    }
    yield '}'
  } else yield JSON.stringify(value) ?? 'null'
}

type Part = { label: string; mime?: string; fragments: Iterable<string> }
function* parts(run: NotebookRunRecord): Generator<Part> {
  yield { label: 'script', fragments: [run.script] }
  // Structured outputs are authoritative; legacy text is used only when absent, avoiding duplicates.
  {
    for (const label of ['stdout', 'stderr', 'traceback'] as const) {
      if (run.text[label]) yield { label, fragments: [run.text[label]] }
    }
    for (const text of run.text.plain ?? []) yield { label: 'text', fragments: [text] }
  }
  const metadata: Partial<NotebookRunRecord> = { ...run }
  delete metadata.script
  delete metadata.outputs
  delete metadata.text
  delete metadata.runtimeId
  delete metadata.helperModules
  delete metadata.submissionIdentity
  delete metadata.submissionFingerprint
  delete metadata.admittedAt
  delete metadata.frozenRuntimeTarget
  delete metadata.frozenPermissionScope
  yield { label: 'metadata', fragments: jsonFragments(metadata, true) }
  for (const output of run.outputs) {
    if (output.type === 'display') {
      for (const mime in output.data) {
        if (Object.prototype.hasOwnProperty.call(output.data, mime))
          yield { label: mime, mime, fragments: [output.data[mime]] }
      }
    } else if (output.type === 'json') {
      yield { label: 'application/json', fragments: jsonFragments(output.data) }
    } else if (output.type === 'error') {
      yield {
        label: 'error',
        fragments: [output.traceback || `${output.name ?? ''}: ${output.message ?? ''}`]
      }
    } else
      yield { label: output.type === 'stream' ? output.name : 'text', fragments: [output.text] }
  }
}

export const readNotebookContent = (
  run: NotebookRunRecord,
  request: NotebookContentRead,
  revision: string
): NotebookContentChunk => {
  if (request.revision !== revision)
    throw new Error('Notebook content changed. Reload the run list.')
  const { part, offset } = request.cursor
  if (![part, offset].every((value) => Number.isSafeInteger(value) && value >= 0))
    throw new Error('Invalid Notebook content cursor.')
  const iterator = parts(run)
  let current = iterator.next()
  for (let index = 0; index < part && !current.done; index++) current = iterator.next()
  if (current.done) throw new Error('Notebook content part no longer exists.')
  let skipped = 0
  let data = ''
  let complete = true
  for (const fragment of current.value.fragments) {
    if (skipped + fragment.length <= offset) {
      skipped += fragment.length
      continue
    }
    const start = Math.max(0, offset - skipped)
    const remaining = NOTEBOOK_READ_CHUNK_CHARACTERS - data.length
    let end = Math.min(fragment.length, start + remaining)
    if (end < fragment.length && end > start && /[\uD800-\uDBFF]/.test(fragment[end - 1])) end--
    data += fragment.slice(start, end)
    skipped += fragment.length
    if (end < fragment.length) {
      complete = false
      break
    }
  }
  if (offset > skipped) throw new Error('Invalid Notebook content offset.')
  const next = !complete
    ? { part, offset: offset + data.length }
    : !iterator.next().done
      ? { part: part + 1, offset: 0 }
      : undefined
  return {
    revision,
    cursor: request.cursor,
    label: current.value.label.slice(0, 1024),
    mime: current.value.mime?.slice(0, 1024),
    data,
    partComplete: complete,
    next
  }
}

export const boundNotebookState = (
  state: NotebookSessionState,
  request: NotebookSessionStateRequest,
  revision: string,
  publicRuns: readonly NotebookRunRecord[]
): NotebookSessionState => {
  if (request.readRevision && request.readRevision !== revision)
    throw new Error('Notebook history changed. Reload the run list.')
  const reference = {
    projectId: request.projectId!,
    sessionId: request.sessionId,
    workspaceCwd: request.workspaceCwd,
    revision
  }
  const result: NotebookSessionState = {
    ...state,
    cells: state.cells.map((cell) => ({ ...cell, code: cell.code.slice(0, 1024) })),
    runs: [],
    recentRuns: [],
    readRevision: revision
  }
  // Inspect only bounded fragments; never serialize an arbitrary imported metadata object first.
  const encodedBytes = (value: unknown, limit: number): number => {
    let bytes = 0
    for (const fragment of jsonFragments(value)) {
      bytes += Buffer.byteLength(fragment, 'utf8')
      if (bytes > limit) throw new Error('Notebook metadata exceeds the bounded view budget.')
    }
    return bytes
  }
  let bytes = encodedBytes(result, NOTEBOOK_READ_PAGE_BYTES / 4)
  if (request.contentRead) {
    const run = publicRuns.find((candidate) => candidate.runId === request.contentRead!.runId)
    if (!run) throw new Error('Notebook run not found.')
    result.contentChunk = readNotebookContent(run, request.contentRead, revision)
    return result
  }
  // Select backwards so a byte-limited page retains the newest contiguous chronological window.
  for (let index = publicRuns.length - 1; index >= 0; index--) {
    const run = summarizeNotebookRun(publicRuns[index], reference)
    const size = encodedBytes(run, NOTEBOOK_READ_PAGE_BYTES / 4) + 1
    if (bytes + size > NOTEBOOK_READ_PAGE_BYTES) break
    bytes += size
    result.runs.unshift(run)
  }
  if (state.historyPage && result.runs.length) {
    const oldest = result.runs[0]
    result.historyPage = {
      hasEarlierRuns: state.historyPage.hasEarlierRuns || result.runs.length < publicRuns.length,
      oldestCursor: { startedAt: oldest.startedAt, runId: oldest.runId }
    }
  }
  return result
}
