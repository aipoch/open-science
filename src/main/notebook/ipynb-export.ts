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
  startedAt: number
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
      appVersion?: string
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
  resolveArtifact?: (
    artifact: NotebookRunRecord['artifacts'][number],
    run: NotebookRunRecord
  ) => Promise<ResolvedArtifact | null>
}

// nbformat accepts either one string or an array of lines. Arrays make generated notebooks stable and
// easy to diff, while preserving every original newline.
const splitLines = (value: string): string[] => {
  if (!value) return []
  const lines = value.match(/[^\n]*\n|[^\n]+$/g)
  return lines ?? []
}

const nbformatCellId = (runId: string): string => {
  const safe = runId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64)
  return safe || 'open-science-cell'
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

const executionCountFor = (run: NotebookRunRecord): number | null =>
  run.status === 'completed' || run.status === 'failed' || run.status === 'timeout'
    ? (run.executionCount ?? null)
    : null

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

const artifactOutputs = async (
  run: NotebookRunRecord,
  resolver: RunDocumentToIpynbOptions['resolveArtifact']
): Promise<NbformatOutput[]> => {
  if (!resolver) return []

  const outputs: NbformatOutput[] = []
  for (const artifact of run.artifacts) {
    try {
      const resolved = await resolver(artifact, run)
      if (resolved) {
        outputs.push({
          output_type: 'display_data',
          data: { [resolved.mimeType]: resolved.data },
          metadata: {}
        })
      }
    } catch {
      outputs.push({
        output_type: 'stream',
        name: 'stderr',
        text: [`[Open Science] Could not inline artifact: ${artifact.name}\n`]
      })
    }
  }
  return outputs
}

const runToCell = async (
  run: NotebookRunRecord,
  options: RunDocumentToIpynbOptions
): Promise<NbformatCodeCell> => {
  const executionCount = executionCountFor(run)
  const structuredOutputs =
    run.outputs.length > 0
      ? run.outputs.map((output) => mapOutput(output, executionCount))
      : fallbackTextOutputs(run)
  const metadata: NbformatCodeCell['metadata'] = {
    open_science: {
      runId: run.runId,
      startedAt: run.startedAt,
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
    id: nbformatCellId(run.runId),
    metadata,
    outputs: [...structuredOutputs, ...(await artifactOutputs(run, options.resolveArtifact))],
    source: splitLines(shellSource(run))
  }
}

// Projects the append-only run document into a standards-compliant nbformat 4.5 notebook without
// changing run.json. Artifact IO is injected so the mapping stays deterministic and unit-testable.
const runDocumentToIpynb = async (
  document: NotebookRunDocument,
  options: RunDocumentToIpynbOptions = {}
): Promise<IpynbNotebook> => {
  const kernel = dominantKernel(document.runs)
  const kernelspec = kernelspecFor(kernel)

  return {
    cells: await Promise.all(document.runs.map((run) => runToCell(run, options))),
    metadata: {
      kernelspec,
      language_info: { name: kernelspec.language },
      open_science: {
        sessionId: document.sessionId,
        projectName: document.projectName,
        ...(options.appVersion ? { appVersion: options.appVersion } : {})
      }
    },
    nbformat: 4,
    nbformat_minor: 5
  }
}

export { runDocumentToIpynb }
export type { IpynbNotebook, ResolvedArtifact, RunDocumentToIpynbOptions }
