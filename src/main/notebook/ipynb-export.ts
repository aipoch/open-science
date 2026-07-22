import type {
  NotebookKernelKind,
  NotebookOutput,
  NotebookRunDocument,
  NotebookRunRecord
} from '../../shared/notebook'

// Minimal nbformat 4.5 shapes — only the subset the export emits. nbformat is plain JSON, so the
// projection is built by hand here: no Python / nbconvert dependency (issue #293, stage 1).
type IpynbStreamOutput = {
  output_type: 'stream'
  name: 'stdout' | 'stderr'
  text: string[]
}

type IpynbErrorOutput = {
  output_type: 'error'
  ename: string
  evalue: string
  traceback: string[]
}

type IpynbDisplayDataOutput = {
  output_type: 'display_data'
  data: Record<string, unknown>
  metadata: Record<string, unknown>
}

type IpynbOutput = IpynbStreamOutput | IpynbErrorOutput | IpynbDisplayDataOutput

type IpynbCellMetadata = {
  // Custom namespace linking every cell back to its run record; Jupyter tools preserve unknown
  // metadata, so this doubles as the provenance anchor for a future re-import / provenance chain.
  open_science: {
    kernel: NotebookKernelKind
    runId: string
    cellId: string
    source: NotebookRunRecord['source']
    status: NotebookRunRecord['status']
    startedAt: string
    endedAt?: string
    environment?: string
  }
}

type IpynbCodeCell = {
  cell_type: 'code'
  id: string
  metadata: IpynbCellMetadata
  source: string[]
  outputs: IpynbOutput[]
  execution_count: number | null
}

type IpynbKernelspec = {
  name: string
  display_name: string
  language: string
}

type IpynbNotebookMetadata = {
  kernelspec: IpynbKernelspec
  language_info: { name: string }
  open_science: {
    sessionId: string
    projectName: string
    artifactSessionId?: string
    appVersion?: string
  }
}

type IpynbNotebook = {
  cells: IpynbCodeCell[]
  metadata: IpynbNotebookMetadata
  nbformat: 4
  nbformat_minor: 5
}

type ProjectIpynbOptions = {
  appVersion?: string
}

const KERNELSPEC_BY_LANGUAGE: Record<
  'python' | 'r',
  { kernelspec: IpynbKernelspec; languageName: string }
> = {
  python: {
    kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
    languageName: 'python'
  },
  r: {
    kernelspec: { name: 'ir', display_name: 'R', language: 'R' },
    languageName: 'R'
  }
}

// Splits text the nbformat way: lines keep their trailing newline, and a trailing newline does not
// produce an empty final element (mirrors Python's splitlines(keepends=True)).
const toMultilineString = (text: string): string[] => {
  const lines: string[] = []
  let start = 0

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      lines.push(text.slice(start, index + 1))
      start = index + 1
    }
  }

  if (start < text.length) {
    lines.push(text.slice(start))
  }

  return lines
}

// nbformat 4.5 requires a unique id per cell; tooling expects [A-Za-z0-9-_]. runIds/cellIds are
// already close to that, so sanitize rather than generate — keeping the id traceable to the run.
const toCellId = (run: NotebookRunRecord, index: number, seen: Set<string>): string => {
  const sanitized = run.cellId.replace(/[^A-Za-z0-9-_]/g, '-').replace(/^-+|-+$/g, '')
  const base = sanitized.length > 0 ? sanitized : `cell-${index}`

  let candidate = base
  let suffix = 2
  while (seen.has(candidate)) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  seen.add(candidate)

  return candidate
}

const projectOutput = (output: NotebookOutput): IpynbOutput => {
  switch (output.type) {
    case 'stream':
      return { output_type: 'stream', name: output.name, text: toMultilineString(output.text) }
    case 'error':
      return {
        output_type: 'error',
        ename: output.name ?? 'Error',
        evalue: output.message ?? '',
        traceback: output.traceback.split('\n')
      }
    case 'display':
      // Text mimes are verbatim and image/png is already base64, so the bundle passes through.
      return { output_type: 'display_data', data: { ...output.data }, metadata: {} }
    case 'json':
      return {
        output_type: 'display_data',
        data: { 'application/json': output.data },
        metadata: {}
      }
    case 'text':
      return { output_type: 'display_data', data: { 'text/plain': output.text }, metadata: {} }
  }
}

// Structured outputs are the primary source; runs persisted before outputs existed (or by kernels
// that only fill the flattened text) fall back to text.stdout/stderr/traceback.
const projectOutputs = (run: NotebookRunRecord): IpynbOutput[] => {
  if (run.outputs.length > 0) {
    return run.outputs.map(projectOutput)
  }

  const fallback: IpynbOutput[] = []
  if (run.text.stdout) {
    fallback.push({
      output_type: 'stream',
      name: 'stdout',
      text: toMultilineString(run.text.stdout)
    })
  }
  if (run.text.stderr) {
    fallback.push({
      output_type: 'stream',
      name: 'stderr',
      text: toMultilineString(run.text.stderr)
    })
  }
  if (run.text.traceback) {
    fallback.push({
      output_type: 'error',
      ename: 'Error',
      evalue: '',
      traceback: run.text.traceback.split('\n')
    })
  }

  return fallback
}

// Shell runs downgrade to a %%bash cell so they stay runnable in a Python kernel. repl runs are
// JavaScript (the control-plane SDK), which no standard cell magic runs — they export verbatim and
// rely on the metadata.open_science.kernel tag instead of a misleading %%bash marker.
const projectSource = (run: NotebookRunRecord): string[] => {
  const lines = toMultilineString(run.script)

  if (run.kernelKind === 'bash') {
    return ['%%bash\n', ...lines]
  }

  return lines
}

const projectRun = (run: NotebookRunRecord, index: number, seen: Set<string>): IpynbCodeCell => ({
  cell_type: 'code',
  id: toCellId(run, index, seen),
  metadata: {
    open_science: {
      kernel: run.kernelKind,
      runId: run.runId,
      cellId: run.cellId,
      source: run.source,
      status: run.status,
      startedAt: new Date(run.startedAt).toISOString(),
      endedAt: run.endedAt === undefined ? undefined : new Date(run.endedAt).toISOString(),
      environment: run.environment
    }
  },
  source: projectSource(run),
  outputs: projectOutputs(run),
  execution_count: run.executionCount ?? null
})

// .ipynb allows exactly one kernelspec: the dominant analysis kernel wins (python on ties and when
// a session has only control-plane runs). Foreign-kernel cells keep their identity in metadata.
const resolveDominantLanguage = (runs: NotebookRunRecord[]): 'python' | 'r' => {
  let pythonRuns = 0
  let rRuns = 0

  for (const run of runs) {
    if (run.kernelKind === 'python') pythonRuns += 1
    if (run.kernelKind === 'r') rRuns += 1
  }

  return rRuns > pythonRuns ? 'r' : 'python'
}

// Pure projection run.json -> .ipynb (nbformat 4.5). Deterministic: the same document always
// produces byte-identical output, and no absolute paths or timestamps are embedded, so the exported
// file is safe to share or publish.
const projectRunDocumentToIpynb = (
  document: NotebookRunDocument,
  options: ProjectIpynbOptions = {}
): IpynbNotebook => {
  const language = resolveDominantLanguage(document.runs)
  const { kernelspec, languageName } = KERNELSPEC_BY_LANGUAGE[language]
  const seen = new Set<string>()

  return {
    cells: document.runs.map((run, index) => projectRun(run, index, seen)),
    metadata: {
      kernelspec,
      language_info: { name: languageName },
      open_science: {
        sessionId: document.sessionId,
        projectName: document.projectName,
        artifactSessionId: document.artifactSessionId,
        appVersion: options.appVersion
      }
    },
    nbformat: 4,
    nbformat_minor: 5
  }
}

// Serializes the projection to the exact bytes to save: indent 1 (matching nbformat's own writer)
// with a trailing newline.
const stringifyIpynb = (notebook: IpynbNotebook): string => `${JSON.stringify(notebook, null, 1)}\n`

export { projectRunDocumentToIpynb, stringifyIpynb }
export type { IpynbNotebook, ProjectIpynbOptions }
