import { createHash } from 'node:crypto'

import type {
  ArtifactCodeReconstruction,
  ArtifactCodeReconstructionState,
  GenerateArtifactCodeReconstructionRequest,
  GetArtifactCodeReconstructionRequest
} from '../../shared/artifact-code-reconstruction'
import type {
  ProvenanceNotebookOutput,
  ProvenanceNotebookRun
} from '../../shared/artifact-provenance'
import { isArtifactNotebookProducer } from '../../shared/artifact-provenance'
import type { NotebookKernelKind } from '../../shared/notebook'
import type { NotebookHelperModuleEvidence } from '../../shared/notebook'
import type { AgentFrameworkId } from '../../shared/settings'
import type { ExplicitAgentBackendTarget } from '../settings/backend-resolver'
import { notebookHelperEvidenceKey } from '../notebook/helper-evidence'
import type { ArtifactVersionReconstructionProvenance } from './provenance-read-model'
import { readArtifactReconstructionEvidence } from './provenance-reconstruction-evidence'

const CONTEXT_MAX_BYTES = 256 * 1024
const PRODUCER_SCRIPT_MAX_BYTES = 160 * 1024
const OUTPUT_MAX_BYTES = 4 * 1024
const RESPONSE_MAX_BYTES = 1024 * 1024
const PROMPT_VERSION = 'artifact-code-reconstruction-v2'

type CodeReconstructionRepository = Pick<
  import('./provenance-repository').ArtifactProvenanceRepository,
  'readCodeReconstructionCache' | 'writeCodeReconstructionCache'
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
  loadProvenance?: (
    request: GetArtifactCodeReconstructionRequest
  ) => Promise<ArtifactVersionReconstructionProvenance>
  runner: CodeReconstructionRunner
  now?: () => Date
}

type ReconstructionSource = {
  provenance: ArtifactVersionReconstructionProvenance
  producerRun: ProvenanceNotebookRun
  language: NotebookKernelKind
  sourceChecksum: string
  sourceTruncated: boolean
}

type ReconstructionCacheBase = {
  artifactVersionId: string
  sourceExecutionChecksum: string
  contextChecksum: string
  promptVersion: typeof PROMPT_VERSION
  language: NotebookKernelKind
  generatedAt: string
  sourceTruncated: boolean
  codeChecksum: string
  code: string
}

type ReconstructionCache = ReconstructionCacheBase &
  (
    | {
        schemaVersion: 1
        frameworkId: AgentFrameworkId
        model: string
      }
    | {
        schemaVersion: 2
        origin: 'app-replay'
      }
    | {
        schemaVersion: 2
        origin: 'llm'
        frameworkId: AgentFrameworkId
        model: string
      }
  )

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
  provenance: ArtifactVersionReconstructionProvenance
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
  const hasHelperKeys = provenance.execution.runs.some(
    (run) => (run.helperModuleKeys?.length ?? 0) > 0
  )
  if (
    (hasHelperKeys &&
      (!provenance.execution.helperModules || !provenance.execution.helperEvidenceStatus)) ||
    (provenance.execution.helperModules?.length && !provenance.execution.helperEvidenceStatus) ||
    (provenance.execution.helperEvidenceStatus?.state === 'complete' &&
      !provenance.execution.helperModules?.length)
  ) {
    return { state: 'unavailable', reason: 'helper-evidence-incomplete' }
  }
  if (provenance.execution.helperEvidenceStatus?.state === 'incomplete') {
    return { state: 'unavailable', reason: 'helper-evidence-incomplete' }
  }
  if (provenance.execution.helperModules?.length) {
    const helperKeys = new Set(provenance.execution.helperModules.map(notebookHelperEvidenceKey))
    if (
      provenance.execution.runs.some((run) =>
        run.helperModuleKeys?.some((key) => !helperKeys.has(key))
      ) ||
      producerRun.scriptTruncated ||
      provenance.execution.truncation?.omittedLeadingRunCount
    ) {
      return { state: 'unavailable', reason: 'supporting-code-incomplete' }
    }
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

const orderedHelpers = (
  helpers: readonly NotebookHelperModuleEvidence[]
): NotebookHelperModuleEvidence[] => {
  const byId = new Map(helpers.map((helper) => [helper.helperId, helper]))
  const ordered: NotebookHelperModuleEvidence[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const visit = (helper: NotebookHelperModuleEvidence): void => {
    if (visited.has(helper.helperId)) return
    if (visiting.has(helper.helperId))
      throw new Error('Helper evidence contains a dependency cycle.')
    visiting.add(helper.helperId)
    for (const dependency of helper.dependencies ?? []) {
      const value = byId.get(dependency)
      if (!value) throw new Error(`Helper evidence is missing dependency: ${dependency}`)
      visit(value)
    }
    visiting.delete(helper.helperId)
    visited.add(helper.helperId)
    ordered.push(helper)
  }
  for (const helper of [...helpers].sort((left, right) =>
    left.helperId.localeCompare(right.helperId)
  )) {
    visit(helper)
  }
  return ordered
}

const buildFreshReplayCode = (source: ReconstructionSource): string | undefined => {
  const producer = source.producerRun
  const allHelpers = source.provenance.execution?.helperModules
  if (!allHelpers?.length || source.language !== 'python') return undefined
  const producerKeys = new Set(producer.helperModuleKeys ?? [])
  if (producerKeys.size === 0) return undefined
  const helpers = allHelpers.filter((helper) => producerKeys.has(notebookHelperEvidenceKey(helper)))
  if (helpers.length !== producerKeys.size) {
    throw new Error('Producer helper evidence is incomplete.')
  }
  const replayRuns = source.provenance
    .execution!.runs.filter(
      (run) =>
        run.runIndex <= producer.runIndex &&
        run.kernelKind === producer.kernelKind &&
        (!producer.kernelEpochId ||
          !run.kernelEpochId ||
          run.kernelEpochId === producer.kernelEpochId)
    )
    .sort((left, right) => left.runIndex - right.runIndex)
  if (replayRuns.some((run) => run.status === 'completed' && run.scriptTruncated)) {
    throw new Error('Supporting cell evidence is incomplete.')
  }
  const byId = new Map(helpers.map((helper) => [helper.helperId, helper]))
  const helperSection = (helper: NotebookHelperModuleEvidence): string => {
    const dependencyExports = (helper.dependencies ?? []).flatMap(
      (dependency) => byId.get(dependency)?.exports ?? []
    )
    return [
      `# === Supporting helper source: ${helper.helperId} (${helper.registeredGeneration}, sha256:${helper.sourceDigest}) ===`,
      `__os_helper_source = ${JSON.stringify(helper.source)}`,
      `__os_dependency_names = ${JSON.stringify(dependencyExports)}`,
      '__os_private = {"__builtins__": __builtins__, **{name: globals()[name] for name in __os_dependency_names}}',
      `exec(compile(__os_helper_source, ${JSON.stringify(`<open-science-helper:${helper.helperId}>`)}, "exec"), __os_private, __os_private)`,
      `__os_exports = ${JSON.stringify(helper.exports)}`,
      '__os_missing = [name for name in __os_exports if name not in __os_private or not callable(__os_private[name])]',
      'if __os_missing:',
      '    raise RuntimeError("OPEN_SCIENCE_HELPER_MISSING_EXPORT")',
      'globals().update({name: __os_private[name] for name in __os_exports})',
      'del __os_helper_source, __os_dependency_names, __os_private, __os_exports, __os_missing'
    ].join('\n')
  }
  const ordered = orderedHelpers(helpers)
  const emittedHelperKeys = new Set<string>()
  const sections: string[] = []
  for (const run of replayRuns) {
    const runHelperKeys = new Set(run.helperModuleKeys ?? [])
    const newlyLoaded = ordered.filter((helper) => {
      const key = notebookHelperEvidenceKey(helper)
      return runHelperKeys.has(key) && !emittedHelperKeys.has(key)
    })
    for (const helper of newlyLoaded) {
      const missingDependency = (helper.dependencies ?? []).find((dependency) => {
        const evidence = byId.get(dependency)
        return !evidence || !runHelperKeys.has(notebookHelperEvidenceKey(evidence))
      })
      if (missingDependency) {
        throw new Error(`Helper evidence is missing dependency: ${missingDependency}`)
      }
      sections.push(helperSection(helper))
      emittedHelperKeys.add(notebookHelperEvidenceKey(helper))
    }
    if (run.runId === producer.runId) {
      sections.push(`# === Producer cell: ${producer.runId} ===\n${producer.script}`)
    } else if (run.status === 'completed') {
      sections.push(`# === Earlier successful cell: ${run.runId} ===\n${run.script}`)
    }
  }
  if ([...producerKeys].some((key) => !emittedHelperKeys.has(key))) {
    throw new Error('Producer helper evidence is incomplete.')
  }
  const code = sections.join('\n\n')
  if (byteLength(code) > RESPONSE_MAX_BYTES) {
    throw new Error('Fresh replay evidence exceeds the bounded reconstruction limit.')
  }
  return code
}

type ReplayCodeResolution =
  | { state: 'available'; code: string | undefined }
  | Extract<ArtifactCodeReconstructionState, { state: 'unavailable' }>

function resolveReplayCode(source: ReconstructionSource): ReplayCodeResolution {
  try {
    return { state: 'available', code: buildFreshReplayCode(source) }
  } catch {
    return { state: 'unavailable', reason: 'supporting-code-incomplete' }
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
    const cache = JSON.parse(serialized) as Partial<ReconstructionCacheBase> & {
      schemaVersion?: unknown
      origin?: unknown
      frameworkId?: unknown
      model?: unknown
    }
    if (
      (cache.schemaVersion !== 1 && cache.schemaVersion !== 2) ||
      cache.artifactVersionId !== source.provenance.evidence.version_id ||
      cache.sourceExecutionChecksum !== source.sourceChecksum ||
      cache.promptVersion !== PROMPT_VERSION ||
      cache.language !== source.language ||
      typeof cache.code !== 'string' ||
      !cache.code.trim() ||
      cache.codeChecksum !== sha256(cache.code) ||
      typeof cache.generatedAt !== 'string'
    ) {
      return undefined
    }
    const common = {
      code: cache.code,
      language: cache.language,
      generatedAt: cache.generatedAt,
      sourceTruncated: cache.sourceTruncated === true
    }
    if (cache.schemaVersion === 2 && cache.origin === 'app-replay') {
      return { ...common, origin: 'app-replay' }
    }
    if (
      (cache.schemaVersion === 1 || cache.origin === 'llm') &&
      typeof cache.model === 'string' &&
      (cache.frameworkId === 'claude-code' ||
        cache.frameworkId === 'opencode' ||
        cache.frameworkId === 'codex' ||
        cache.frameworkId === 'codebuddy')
    ) {
      return {
        ...common,
        origin: 'llm',
        frameworkId: cache.frameworkId,
        model: cache.model
      }
    }
    return undefined
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
    if (cached) return { state: 'cached', value: cached }
    const replay = resolveReplayCode(source)
    if (replay.state === 'unavailable') return replay
    return {
      state: 'ready',
      origin: replay.code ? 'app-replay' : 'llm',
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
    const source = await this.loadSource(request)
    if (!isSource(source)) return source
    const existing = parseCache(
      await this.options.provenance.readCodeReconstructionCache(request),
      source
    )
    if (existing) return { state: 'cached', value: existing }

    const replay = resolveReplayCode(source)
    if (replay.state === 'unavailable') return replay
    const replayCode = replay.code
    const generatedAt = this.now().toISOString()
    const commonCache = {
      artifactVersionId: source.provenance.evidence.version_id,
      sourceExecutionChecksum: source.sourceChecksum,
      promptVersion: PROMPT_VERSION,
      language: source.language,
      generatedAt
    } as const
    let cache: ReconstructionCache
    let value: ArtifactCodeReconstruction
    if (replayCode) {
      value = {
        origin: 'app-replay',
        code: replayCode,
        language: source.language,
        generatedAt,
        sourceTruncated: source.sourceTruncated
      }
      cache = {
        ...commonCache,
        schemaVersion: 2,
        origin: 'app-replay',
        contextChecksum: sha256(replayCode),
        sourceTruncated: value.sourceTruncated,
        codeChecksum: sha256(replayCode),
        code: replayCode
      }
    } else {
      // Snapshot the non-secret identity only for model-backed reconstruction. Credentials remain
      // resolved at spawn time by the runner.
      const target = await this.options.runner.captureTarget()
      const context = buildContext(source)
      const result = await this.options.runner.run(buildPrompt(context.serialized), target)
      const code = normalizeResponse(result.text)
      value = {
        origin: 'llm',
        code,
        language: source.language,
        generatedAt,
        frameworkId: result.frameworkId,
        model: result.model,
        sourceTruncated: source.sourceTruncated || context.truncated
      }
      cache = {
        ...commonCache,
        schemaVersion: 2,
        origin: 'llm',
        contextChecksum: context.checksum,
        frameworkId: result.frameworkId,
        model: result.model,
        sourceTruncated: value.sourceTruncated,
        codeChecksum: sha256(code),
        code
      }
    }
    await this.options.provenance.writeCodeReconstructionCache(
      request,
      `${JSON.stringify(cache, null, 2)}\n`
    )
    return { state: 'cached', value }
  }

  private async loadSource(
    request: GetArtifactCodeReconstructionRequest
  ): Promise<ReconstructionSource | ArtifactCodeReconstructionState> {
    return sourceState(
      await (this.options.loadProvenance?.(request) ??
        readArtifactReconstructionEvidence(this.options.provenance, request))
    )
  }
}

export { CONTEXT_MAX_BYTES, PROMPT_VERSION, buildContext, buildFreshReplayCode, normalizeResponse }
