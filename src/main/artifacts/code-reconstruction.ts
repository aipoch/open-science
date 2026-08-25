import { createHash } from 'node:crypto'

import type {
  ArtifactCodeReconstruction,
  ArtifactCodeReconstructionState,
  GenerateArtifactCodeReconstructionRequest,
  GetArtifactCodeReconstructionRequest
} from '../../shared/artifact-code-reconstruction'
import type {
  ArtifactVersionProvenance,
  ProvenanceNotebookOutput,
  ProvenanceNotebookRun
} from '../../shared/artifact-provenance'
import { isArtifactNotebookProducer } from '../../shared/artifact-provenance'
import type { NotebookKernelKind } from '../../shared/notebook'
import type { AgentFrameworkId } from '../../shared/settings'
import type { ExplicitAgentBackendTarget } from '../settings/backend-resolver'

const CONTEXT_MAX_BYTES = 256 * 1024
const PRODUCER_SCRIPT_MAX_BYTES = 160 * 1024
const OUTPUT_MAX_BYTES = 4 * 1024
const RESPONSE_MAX_BYTES = 1024 * 1024
const PROMPT_VERSION = 'artifact-code-reconstruction-v2'

type CodeReconstructionRepository = Pick<
  import('./provenance-repository').ArtifactProvenanceRepository,
  'getVersionProvenance' | 'readCodeReconstructionCache' | 'writeCodeReconstructionCache'
>

type CodeReconstructionRunner = {
  captureTarget(): Promise<ExplicitAgentBackendTarget>
  run(
    prompt: string,
    target: ExplicitAgentBackendTarget
  ): Promise<{ text: string; frameworkId: AgentFrameworkId; model: string }>
}

type ArtifactCodeReconstructionServiceOptions = {
  provenance: CodeReconstructionRepository
  runner: CodeReconstructionRunner
  now?: () => Date
}

type ReconstructionSource = {
  provenance: ArtifactVersionProvenance
  producerRun: ProvenanceNotebookRun
  language: NotebookKernelKind
  sourceChecksum: string
  sourceTruncated: boolean
}

type ReconstructionCache = {
  schemaVersion: 1
  artifactVersionId: string
  sourceExecutionChecksum: string
  contextChecksum: string
  promptVersion: typeof PROMPT_VERSION
  frameworkId: AgentFrameworkId
  model: string
  language: NotebookKernelKind
  generatedAt: string
  sourceTruncated: boolean
  codeChecksum: string
  code: string
}

type ReconstructionContext = {
  schemaVersion: 1
  target: {
    artifactId: string
    artifactVersionId: string
    versionNumber: number
    filename: string
    contentType: string | null
    artifactChecksum: string
  }
  producer: {
    runId: string
    runIndex: number
    kernelKind: NotebookKernelKind
    environmentName: string | null
  }
  execution: {
    sourceChecksum: string
    sourceTruncated: boolean
    runs: ReconstructionRun[]
  }
  inputs: Array<{
    kind: 'upload' | 'artifact'
    filename: string
    fileId: string
    fileVersionId: string
    versionNumber: number | null
    contentType: string | null
    checksum: string
  }>
  environment: {
    runtimeName: string | null
    runtimeVersion: string | null
    relevantPackages: Array<{ name: string; version: string | null }>
  }
  omissions: {
    omittedRuns: number
    omittedOutputs: number
    omittedBytes: number
    reasons: string[]
  }
}

type ReconstructionRun = {
  runId: string
  runIndex: number
  kernelKind: NotebookKernelKind
  environmentName: string | null
  status: string
  script: string
  scriptTruncated: boolean
  outputs: Array<{ kind: string; text: string; truncated: boolean }>
  inputFileVersionIds: string[]
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8')

const clipUtf8 = (value: string, maxBytes: number): { text: string; truncated: boolean } => {
  if (byteLength(value) <= maxBytes) return { text: value, truncated: false }
  const clipped = new TextDecoder().decode(Buffer.from(value).subarray(0, maxBytes))
  return { text: `${clipped}\n…[truncated]`, truncated: true }
}

const outputText = (output: ProvenanceNotebookOutput): { kind: string; text: string } => {
  if (output.type === 'text') return { kind: 'text', text: output.text }
  if (output.type === 'error') {
    return {
      kind: 'error',
      text: [output.name, output.message, ...(output.traceback ?? [])].filter(Boolean).join('\n')
    }
  }
  if (output.type === 'table') {
    return {
      kind: 'table',
      text: JSON.stringify({
        columns: output.columns,
        rowCount: output.rowCount,
        previewRows: output.previewRows
      })
    }
  }
  return {
    kind: 'omitted-media',
    text: JSON.stringify({ mimeType: output.mimeType, byteLength: output.byteLength ?? null })
  }
}

const projectRun = (run: ProvenanceNotebookRun, maxScriptBytes: number): ReconstructionRun => {
  const script = clipUtf8(run.script, maxScriptBytes)
  return {
    runId: run.runId,
    runIndex: run.runIndex,
    kernelKind: run.kernelKind,
    environmentName: run.environmentName ?? null,
    status: run.status,
    script: script.text,
    scriptTruncated: run.scriptTruncated === true || script.truncated,
    outputs: run.outputs.map((output) => {
      const value = outputText(output)
      const clipped = clipUtf8(value.text, OUTPUT_MAX_BYTES)
      return {
        kind: value.kind,
        text: clipped.text,
        truncated: clipped.truncated || (output.type === 'text' && output.truncated === true)
      }
    }),
    inputFileVersionIds: run.inputFileVersionKeys.map((input) => input.inputFileVersionId)
  }
}

const sourceState = (
  provenance: ArtifactVersionProvenance
): ReconstructionSource | ArtifactCodeReconstructionState => {
  if (!provenance.execution || !provenance.evidence.execution_snapshot_checksum) {
    return { state: 'unavailable', reason: 'execution-unavailable' }
  }
  const producer = provenance.evidence.producer
  if (!isArtifactNotebookProducer(producer)) {
    return { state: 'unavailable', reason: 'producer-unavailable' }
  }
  const producerRun = provenance.execution.runs.find(
    (run) => run.runId === producer.producer_run_id
  )
  if (!producerRun?.script.trim()) {
    return { state: 'unavailable', reason: 'producer-script-missing' }
  }
  return {
    provenance,
    producerRun,
    language: producer.kernel_kind,
    sourceChecksum: provenance.evidence.execution_snapshot_checksum,
    sourceTruncated: Boolean(
      provenance.execution.truncation ||
      producerRun.scriptTruncated ||
      producerRun.hasOmittedFiles ||
      producerRun.hasOmittedInputs ||
      producerRun.omittedOutputCount
    )
  }
}

const isSource = (
  value: ReconstructionSource | ArtifactCodeReconstructionState
): value is ReconstructionSource => 'provenance' in value

const buildContext = (
  source: ReconstructionSource
): { serialized: string; checksum: string; truncated: boolean } => {
  const { provenance, producerRun } = source
  const earlierRuns = provenance
    .execution!.runs.filter(
      (run) =>
        run.runId !== producerRun.runId &&
        run.runIndex <= producerRun.runIndex &&
        run.status === 'completed'
    )
    .sort((left, right) => right.runIndex - left.runIndex)
  const producer = projectRun(producerRun, PRODUCER_SCRIPT_MAX_BYTES)
  const scripts = [producer.script, ...earlierRuns.map((run) => run.script)].join('\n')
  const environment = provenance.evidence.environment
  const context: ReconstructionContext = {
    schemaVersion: 1,
    target: {
      artifactId: provenance.evidence.artifact_id,
      artifactVersionId: provenance.evidence.version_id,
      versionNumber: provenance.evidence.version_number,
      filename: provenance.evidence.filename,
      contentType: provenance.evidence.content_type ?? null,
      artifactChecksum: provenance.evidence.checksum
    },
    producer: {
      runId: producerRun.runId,
      runIndex: producerRun.runIndex,
      kernelKind: producerRun.kernelKind,
      environmentName: producerRun.environmentName ?? null
    },
    execution: {
      sourceChecksum: source.sourceChecksum,
      sourceTruncated: source.sourceTruncated,
      runs: [producer]
    },
    inputs: provenance.evidence.inputs.map((input) => ({
      kind: input.source_kind === 'upload-version' ? 'upload' : 'artifact',
      filename: input.filename,
      fileId: input.source_file_id,
      fileVersionId: input.input_file_version_id,
      versionNumber: input.source_version_number ?? null,
      contentType: input.content_type ?? null,
      checksum: input.checksum
    })),
    environment: {
      runtimeName: environment?.environment_name ?? null,
      runtimeVersion: environment?.runtime_version ?? null,
      relevantPackages: (environment?.packages ?? [])
        .filter((pkg) => scripts.toLowerCase().includes(pkg.name.toLowerCase()))
        .slice(0, 64)
        .map((pkg) => ({ name: pkg.name, version: pkg.version ?? null }))
    },
    omissions: {
      omittedRuns: provenance.execution!.truncation?.omittedLeadingRunCount ?? 0,
      omittedOutputs: provenance.execution!.truncation?.omittedOutputCount ?? 0,
      omittedBytes: 0,
      reasons: provenance.execution!.truncation ? ['source-log-payload-limit'] : []
    }
  }

  for (const run of earlierRuns) {
    const projected = projectRun(run, PRODUCER_SCRIPT_MAX_BYTES)
    context.execution.runs.push(projected)
    if (byteLength(JSON.stringify(context)) > CONTEXT_MAX_BYTES) {
      context.execution.runs.pop()
      context.omissions.omittedRuns += 1
      context.omissions.omittedOutputs += run.outputs.length
      context.omissions.omittedBytes += byteLength(JSON.stringify(projected))
      if (!context.omissions.reasons.includes('context-byte-limit')) {
        context.omissions.reasons.push('context-byte-limit')
      }
    }
  }

  let serialized = JSON.stringify(context)
  if (byteLength(serialized) > CONTEXT_MAX_BYTES) {
    const producerWithoutOutputs = { ...producer, outputs: [] }
    context.omissions.omittedOutputs += producer.outputs.length
    context.omissions.omittedBytes += byteLength(JSON.stringify(producer.outputs))
    if (!context.omissions.reasons.includes('context-byte-limit')) {
      context.omissions.reasons.push('context-byte-limit')
    }
    context.execution.runs = [producerWithoutOutputs]
    serialized = JSON.stringify(context)
  }
  if (byteLength(serialized) > CONTEXT_MAX_BYTES) {
    throw new Error('The producer script is too large to reconstruct safely.')
  }
  return {
    serialized,
    checksum: sha256(serialized),
    truncated:
      context.omissions.reasons.length > 0 ||
      context.execution.runs.some(
        (run) => run.scriptTruncated || run.outputs.some((output) => output.truncated)
      )
  }
}

const escapePromptEvidence = (context: string): string =>
  context.replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')

const buildPrompt = (context: string): string =>
  [
    'Return one standalone script in the producer kernel language.',
    'The script must read inputs by their exact captured filenames and recreate the exact target filename.',
    'Include imports and setup supported by the evidence. Collapse exploratory, duplicate, and failed iterations into one coherent path.',
    'Do not invent data, parameters, packages, or transformations. If missing evidence materially affects the result, add one concise language-appropriate provenance-gap comment.',
    'Return code only, without Markdown or explanation. If reconstruction is not defensible, return exactly RECONSTRUCTION_UNAVAILABLE: followed by a short reason.',
    '',
    '<artifact_execution_evidence>',
    escapePromptEvidence(context),
    '</artifact_execution_evidence>'
  ].join('\n')

const normalizeResponse = (value: string): string => {
  const trimmed = value.trim()
  if (!trimmed) throw new Error('The selected model returned an empty reconstruction.')
  if (trimmed.startsWith('RECONSTRUCTION_UNAVAILABLE:')) {
    throw new Error(trimmed)
  }
  if (byteLength(trimmed) > RESPONSE_MAX_BYTES) {
    throw new Error('The selected model returned a reconstruction that is too large.')
  }
  const fenced = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n```$/u)
  if (fenced) {
    if (fenced[1]!.includes('```')) {
      throw new Error('The selected model returned multiple or malformed code blocks.')
    }
    return fenced[1]!.trimEnd()
  }
  if (trimmed.includes('```')) {
    throw new Error('The selected model returned multiple or malformed code blocks.')
  }
  return trimmed
}

const parseCache = (
  serialized: string | undefined,
  source: ReconstructionSource
): ArtifactCodeReconstruction | undefined => {
  if (!serialized) return undefined
  try {
    const cache = JSON.parse(serialized) as Partial<ReconstructionCache>
    if (
      cache.schemaVersion !== 1 ||
      cache.artifactVersionId !== source.provenance.evidence.version_id ||
      cache.sourceExecutionChecksum !== source.sourceChecksum ||
      cache.promptVersion !== PROMPT_VERSION ||
      cache.language !== source.language ||
      typeof cache.code !== 'string' ||
      !cache.code.trim() ||
      cache.codeChecksum !== sha256(cache.code) ||
      typeof cache.generatedAt !== 'string' ||
      typeof cache.model !== 'string' ||
      (cache.frameworkId !== 'claude-code' &&
        cache.frameworkId !== 'opencode' &&
        cache.frameworkId !== 'codex' &&
        cache.frameworkId !== 'codebuddy')
    ) {
      return undefined
    }
    return {
      code: cache.code,
      language: cache.language,
      generatedAt: cache.generatedAt,
      frameworkId: cache.frameworkId,
      model: cache.model,
      sourceTruncated: cache.sourceTruncated === true
    }
  } catch {
    return undefined
  }
}

export class ArtifactCodeReconstructionService {
  private readonly inFlight = new Map<string, Promise<ArtifactCodeReconstructionState>>()
  private activeKey: string | undefined
  private readonly now: () => Date

  constructor(private readonly options: ArtifactCodeReconstructionServiceOptions) {
    this.now = options.now ?? (() => new Date())
  }

  async get(
    request: GetArtifactCodeReconstructionRequest
  ): Promise<ArtifactCodeReconstructionState> {
    const source = await this.loadSource(request)
    if (!isSource(source)) return source
    const cached = parseCache(
      await this.options.provenance.readCodeReconstructionCache(request),
      source
    )
    return cached
      ? { state: 'cached', value: cached }
      : {
          state: 'ready',
          language: source.language,
          sourceTruncated: source.sourceTruncated
        }
  }

  generate(
    request: GenerateArtifactCodeReconstructionRequest
  ): Promise<ArtifactCodeReconstructionState> {
    const key = [
      request.projectId,
      request.appSessionId,
      request.artifactId,
      request.versionId
    ].join(':')
    const existing = this.inFlight.get(key)
    if (existing) return existing
    if (this.activeKey) {
      return Promise.reject(
        new Error('Another Artifact script is being generated. Try again shortly.')
      )
    }

    this.activeKey = key
    const promise = this.generateFresh(request).finally(() => {
      this.inFlight.delete(key)
      if (this.activeKey === key) this.activeKey = undefined
    })
    this.inFlight.set(key, promise)
    return promise
  }

  private async generateFresh(
    request: GenerateArtifactCodeReconstructionRequest
  ): Promise<ArtifactCodeReconstructionState> {
    // Snapshot the non-secret identity before evidence I/O so the click, not a later settings state,
    // determines the framework/provider/model/effort. Credentials are still resolved only at spawn.
    const target = await this.options.runner.captureTarget()
    const source = await this.loadSource(request)
    if (!isSource(source)) return source
    const existing = parseCache(
      await this.options.provenance.readCodeReconstructionCache(request),
      source
    )
    if (existing) return { state: 'cached', value: existing }

    const context = buildContext(source)
    const result = await this.options.runner.run(buildPrompt(context.serialized), target)
    const code = normalizeResponse(result.text)
    const cache: ReconstructionCache = {
      schemaVersion: 1,
      artifactVersionId: source.provenance.evidence.version_id,
      sourceExecutionChecksum: source.sourceChecksum,
      contextChecksum: context.checksum,
      promptVersion: PROMPT_VERSION,
      frameworkId: result.frameworkId,
      model: result.model,
      language: source.language,
      generatedAt: this.now().toISOString(),
      sourceTruncated: source.sourceTruncated || context.truncated,
      codeChecksum: sha256(code),
      code
    }
    await this.options.provenance.writeCodeReconstructionCache(
      request,
      `${JSON.stringify(cache, null, 2)}\n`
    )
    return {
      state: 'cached',
      value: {
        code,
        language: cache.language,
        generatedAt: cache.generatedAt,
        frameworkId: cache.frameworkId,
        model: cache.model,
        sourceTruncated: cache.sourceTruncated
      }
    }
  }

  private async loadSource(
    request: GetArtifactCodeReconstructionRequest
  ): Promise<ReconstructionSource | ArtifactCodeReconstructionState> {
    return sourceState(
      await this.options.provenance.getVersionProvenance(request, {
        execution: true,
        messages: false,
        review: false
      })
    )
  }
}

export { CONTEXT_MAX_BYTES, PROMPT_VERSION, buildContext, normalizeResponse }
