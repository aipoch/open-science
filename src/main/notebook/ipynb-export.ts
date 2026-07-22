import type {
  NotebookKernelKind,
  NotebookOutput,
  NotebookRunDocument,
  NotebookRunRecord
} from '../../shared/notebook'

type NbformatOutput =
  | {
      output_type: 'stream'
      name: 'stdout' | 'stderr'
      text: string[]
    }
  | {
      output_type: 'error'
      ename: string
      evalue: string
      traceback: string[]
    }
  | {
      output_type: 'display_data' | 'execute_result'
      data: Record<string, unknown>
      metadata: Record<string, unknown>
      execution_count?: number | null
    }

type OpenScienceCellMetadata = {
  runId: string
  cellId: string
  source: NotebookRunRecord['source']
  startedAt: number
  endedAt?: number
  status: NotebookRunRecord['status']
  kernel: NotebookKernelKind
  environment?: string
}

type NbformatCodeCell = {
  cell_type: 'code'
  execution_count: number | null
  id: string
  metadata: {
    open_science: OpenScienceCellMetadata
    tags?: string[]
  }
  outputs: NbformatOutput[]
  source: string[]
}

type IpynbNotebook = {
  cells: NbformatCodeCell[]
  metadata: {
    kernelspec: {
      display_name: string
      language: string
      name: string
    }
    language_info: {
      name: string
    }
    open_science: {
      sessionId: string
      projectName: string
      artifactSessionId?: string
      appVersion?: string
      // The dominant analysis kernel's env (see dominantEnvironment), per issue #293's
      // notebook-level metadata; omitted when no analysis run recorded one.
      environment?: string
    }
  }
  nbformat: 4
  nbformat_minor: 5
}

type ResolvedArtifact = {
  mimeType: string
  data: unknown
}

type RunDocumentToIpynbOptions = {
  appVersion?: string
  // Per-run artifact outputs keyed by runId, produced by the caller's async IO phase (artifact
  // file reads) BEFORE this projection runs — keeping this module a pure function of
  // (document, artifactOutputs, appVersion) whose result never depends on filesystem state.
  artifactOutputs?: ReadonlyMap<string, NbformatOutput[]>
}

type KernelSplitIpynb = Partial<Record<'python' | 'r', IpynbNotebook>>

// nbformat accepts either one string or an array of lines. Arrays make generated notebooks stable and
// easy to diff, while preserving every original newline.
const splitLines = (value: string): string[] => {
  if (!value) return []
  const lines = value.match(/[^\n]*\n|[^\n]+$/g)
  return lines ?? []
}

// nbformat 4.5 cell ids are 1-64 chars of [A-Za-z0-9-_] and must be unique per notebook. runIds
// already satisfy that almost always, so sanitize rather than generate; dedup suffixes (only
// reachable via truncation collisions or empty ids) reserve room from the same 64-char budget.
const MAX_CELL_ID_LENGTH = 64

const nbformatCellId = (runId: string, seen: Set<string>): string => {
  const base =
    runId
      .replace(/[^A-Za-z0-9_-]/g, '-')
      .slice(0, MAX_CELL_ID_LENGTH)
      .replace(/^-+|-+$/g, '') || 'open-science-cell'

  let candidate = base
  let suffix = 2
  while (seen.has(candidate)) {
    const suffixText = `-${suffix}`
    candidate = `${base.slice(0, MAX_CELL_ID_LENGTH - suffixText.length)}${suffixText}`
    suffix += 1
  }
  seen.add(candidate)

  return candidate
}

const shellSource = (run: NotebookRunRecord): string => {
  if (run.kernelKind === 'bash') return `%%bash\n${run.script}`
  if (run.kernelKind === 'repl') return `%%javascript\n${run.script}`
  return run.script
}

const errorName = (output: Extract<NotebookOutput, { type: 'error' }>): string =>
  output.name?.trim() || 'Error'

const errorValue = (output: Extract<NotebookOutput, { type: 'error' }>): string =>
  output.message?.trim() || output.traceback.split('\n')[0] || 'Notebook execution failed'

const mapOutput = (output: NotebookOutput, executionCount: number | null): NbformatOutput => {
  switch (output.type) {
    case 'stream':
      return {
        output_type: 'stream',
        name: output.name,
        text: splitLines(output.text)
      }
    case 'error':
      return {
        output_type: 'error',
        ename: errorName(output),
        evalue: errorValue(output),
        traceback: splitLines(output.traceback)
      }
    case 'text':
      return {
        output_type: 'execute_result',
        data: { 'text/plain': output.text },
        metadata: {},
        execution_count: executionCount
      }
    case 'json':
      return {
        output_type: 'display_data',
        data: { 'application/json': output.data },
        metadata: {}
      }
    case 'display':
      return {
        output_type: 'display_data',
        data: output.data,
        metadata: {}
      }
  }
}

const fallbackTextOutputs = (run: NotebookRunRecord): NbformatOutput[] => {
  const outputs: NbformatOutput[] = []
  if (run.text.stdout) {
    outputs.push({ output_type: 'stream', name: 'stdout', text: splitLines(run.text.stdout) })
  }
  if (run.text.stderr) {
    outputs.push({ output_type: 'stream', name: 'stderr', text: splitLines(run.text.stderr) })
  }
  if (run.text.traceback) {
    outputs.push({
      output_type: 'error',
      ename: 'Error',
      evalue: run.text.traceback.split('\n')[0] || 'Notebook execution failed',
      traceback: splitLines(run.text.traceback)
    })
  }
  return outputs
}

// Direct field mapping per issue #293: run.json's executionCount passes through for every status —
// including interrupted/cancelled runs, which still executed (partially) under that count.
const executionCountFor = (run: NotebookRunRecord): number | null => run.executionCount ?? null

const dominantKernel = (runs: NotebookRunRecord[]): 'python' | 'r' => {
  let python = 0
  let r = 0
  for (const run of runs) {
    if (run.kernelKind === 'python') python += 1
    if (run.kernelKind === 'r') r += 1
  }
  return r > python ? 'r' : 'python'
}

const kernelspecFor = (kernel: 'python' | 'r'): IpynbNotebook['metadata']['kernelspec'] =>
  kernel === 'r'
    ? { display_name: 'R', language: 'R', name: 'ir' }
    : { display_name: 'Python 3', language: 'python', name: 'python3' }

// The notebook-level environment name (#293): the dominant analysis kernel's most frequent run
// environment. Ties resolve to first-seen (Map insertion order), keeping the pick deterministic.
const dominantEnvironment = (
  runs: NotebookRunRecord[],
  kernel: 'python' | 'r'
): string | undefined => {
  const counts = new Map<string, number>()
  for (const run of runs) {
    if (run.kernelKind !== kernel || !run.environment) continue
    counts.set(run.environment, (counts.get(run.environment) ?? 0) + 1)
  }

  let best: string | undefined
  let bestCount = 0
  for (const [environment, count] of counts) {
    if (count > bestCount) {
      best = environment
      bestCount = count
    }
  }

  return best
}

const runToCell = (
  run: NotebookRunRecord,
  options: RunDocumentToIpynbOptions,
  seen: Set<string>
): NbformatCodeCell => {
  const executionCount = executionCountFor(run)
  const structuredOutputs =
    run.outputs.length > 0
      ? run.outputs.map((output) => mapOutput(output, executionCount))
      : fallbackTextOutputs(run)
  const metadata: NbformatCodeCell['metadata'] = {
    open_science: {
      runId: run.runId,
      cellId: run.cellId,
      source: run.source,
      startedAt: run.startedAt,
      ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
      status: run.status,
      kernel: run.kernelKind,
      ...(run.environment ? { environment: run.environment } : {})
    }
  }

  if (run.kernelKind === 'bash' || run.kernelKind === 'repl') {
    metadata.tags = [`open-science-${run.kernelKind}`]
  }

  return {
    cell_type: 'code',
    execution_count: executionCount,
    id: nbformatCellId(run.runId, seen),
    metadata,
    outputs: [...structuredOutputs, ...(options.artifactOutputs?.get(run.runId) ?? [])],
    source: splitLines(shellSource(run))
  }
}

// Pure, synchronous projection of the append-only run document into a standards-compliant nbformat
// 4.5 notebook, without changing run.json. All IO (artifact file reads) happens in the caller
// beforehand and arrives via options.artifactOutputs, so the output is byte-identical for the same
// (document, artifactOutputs, appVersion) inputs and never depends on filesystem state.
const runDocumentToIpynb = (
  document: NotebookRunDocument,
  options: RunDocumentToIpynbOptions = {}
): IpynbNotebook => {
  const kernel = dominantKernel(document.runs)
  const kernelspec = kernelspecFor(kernel)
  const environment = dominantEnvironment(document.runs, kernel)
  const seen = new Set<string>()

  return {
    cells: document.runs.map((run) => runToCell(run, options, seen)),
    metadata: {
      kernelspec,
      language_info: { name: kernelspec.language },
      open_science: {
        sessionId: document.sessionId,
        projectName: document.projectName,
        ...(document.artifactSessionId ? { artifactSessionId: document.artifactSessionId } : {}),
        ...(options.appVersion ? { appVersion: options.appVersion } : {}),
        ...(environment ? { environment } : {})
      }
    },
    nbformat: 4,
    nbformat_minor: 5
  }
}

// Splits a mixed history into chronological per-data-kernel projections. Control-plane runs follow
// the most recently active data kernel (or the dominant kernel before the first data cell), preserving
// their local context without duplicating them across notebooks.
const runDocumentToIpynbByKernel = async (
  document: NotebookRunDocument,
  options: RunDocumentToIpynbOptions = {}
): Promise<KernelSplitIpynb> => {
  const groups: Record<'python' | 'r', NotebookRunRecord[]> = { python: [], r: [] }
  let activeKernel = dominantKernel(document.runs)
  for (const run of document.runs) {
    if (run.kernelKind === 'python' || run.kernelKind === 'r') {
      activeKernel = run.kernelKind
    }
    groups[activeKernel].push(run)
  }

  const result: KernelSplitIpynb = {}
  for (const kernel of ['python', 'r'] as const) {
    if (groups[kernel].length === 0) continue
    result[kernel] = await runDocumentToIpynb({ ...document, runs: groups[kernel] }, options)
  }
  return result
}

export { runDocumentToIpynb, runDocumentToIpynbByKernel }
export type {
  IpynbNotebook,
  KernelSplitIpynb,
  NbformatOutput,
  ResolvedArtifact,
  RunDocumentToIpynbOptions
}
