import { OfflinePlanAdmission } from './offline-plan-admission'
import {
  executeOfflinePlanRequestSchema,
  type OfflinePlanInspection
} from '../../shared/offline-execution'
import { configuredCredentialPatterns, screenAuxiliaryOutput } from './screened-auxiliary-output'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readdir, open } from 'node:fs/promises'
import { ResearchExecutionConfigurationBroker } from '../research-execution-profiles/configuration-broker'
import { satisfies, validRange } from 'semver'
import {
  researchExecutionPreflightRequestSchema,
  researchEnvironmentVariableSchema,
  saveResearchExecutionProfileRequestSchema,
  type ResearchExecutionPreflight,
  type ResearchExecutionSecretSlot,
  type ResearchExecutionBinding,
  type ResearchExecutionProfileView,
  type ResearchExecutionPreflightRequest,
  type ResearchExecutionConfigurationSnapshot
} from '../../shared/research-execution-profile'
import type {
  ResearchExecutionCredentialLease,
  ResearchExecutionProfileStore
} from '../research-execution-profiles/store'
import { join } from 'node:path'
import { z } from 'zod'
import {
  createManagedSessionRequestSchema,
  collectManagedOutputsRequestSchema,
  executeManagedEnvironmentRequestSchema,
  inspectManagedMaterialsRequestSchema,
  managedEnvironmentReferenceSchema,
  managedCollectionReferenceSchema,
  managedOutputSelectionSchema,
  managedOperationReferenceSchema,
  managedObservationResultSchema,
  prepareManagedEnvironmentRequestSchema,
  type CreateManagedSessionRequest,
  type ManagedObservationResult,
  type ManagedRuntimeDiagnosticCode,
  type ManagedRuntimeDiagnostics
} from '../../shared/managed-execution'
import type { NotebookRunInputFile, NotebookRunRecord } from '../../shared/notebook'
import {
  legacyDemoViewingAdmissionSchema as runObservationDemoViewingAdmissionSchema,
  type LegacyDemoViewingAdmission as RunObservationDemoViewingAdmission,
  type ManagedObservationTarget as RunObservationTarget,
  type ManagedObservationHandle as RunObservationRecordingHandle,
  type ManagedExecutionObservationPort
} from './managed-execution-observation-port'
import type { ArtifactVersionDescriptor } from '../../shared/artifact-provenance'
import {
  runtimeViewLaunchSchema,
  type RuntimeViewLaunch,
  type RuntimeViewScope
} from '../../shared/runtime-view'
import type { ManagedServiceProof, ManagedShellOutput } from './managed-shell-execution'
import type { NotebookRunRepository } from './repository'
import type { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { MAX_ARTIFACT_VERSION_DESCRIPTOR_IDS } from '../../shared/artifacts'
import { digestFileWithinBudget } from '../bounded-file-io'
import {
  DurableJsonRecoveryBarrierError,
  readDurableJsonFile,
  writeDurableJsonFile
} from '../storage/durable-json-file'
import {
  inspectResearchMaterials,
  type ResearchMaterialAuthority,
  type ResearchMaterialVersion
} from './research-materials'
import {
  ManagedEnvironmentCancelledError,
  type ManagedEnvironmentExecutionContext,
  type ManagedResearchEnvironment,
  type ManagedResearchEnvironmentOwner,
  type ManagedResearchRuntime
} from './managed-research-environment'
import type { NotebookRuntimeService } from './runtime-service'
import type { SessionOperationContext, SessionOperationOwner } from './session-operation-owner'
import {
  resolveManagedOutputAuthority,
  type ManagedOutputAuthority
} from './managed-output-authority'
import {
  createManagedOutputRecoveryAuthority,
  revokeManagedOutputRecoveryAuthority
} from './managed-output-recovery'
import {
  managedOutputWriteAttemptSchema,
  type ManagedOutputWriteAttempt
} from './managed-output-publication'

export type ManagedExecutionTurnContext = Pick<
  SessionOperationContext,
  | 'operationId'
  | 'projectId'
  | 'sessionId'
  | 'workspaceCwd'
  | 'provenanceContext'
  | 'recordRun'
  | 'saveOutput'
  | 'saveAuxiliaryOutput'
  | 'recoverOutput'
> & {
  /** Exact Main control invocation, present only when borrowing an active Agent turn. */
  executionInvocationId?: string
}
const projectRecordingResultSchema = z
  .object({
    status: z.enum(['saved', 'unavailable']),
    artifactId: z.string().optional(),
    versionId: z.string().optional(),
    warnings: z.array(z.string()).max(32)
  })
  .strict()
export type ManagedProjectRecordingResult = z.infer<typeof projectRecordingResultSchema>
const resultSchema = z
  .object({
    collectionId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    executionInvocationId: z.string(),
    runId: z.string(),
    status: z.enum(['completed', 'failed', 'cancelled']),
    exitCode: z.number().int().nullable(),
    outputs: z.array(z.object({ filename: z.string(), versionId: z.string() }).strict()).max(102),
    missingOptionalOutputs: z.array(z.string()).max(100),
    missingCancelledOutputs: z.array(z.string()).max(100).optional(),
    observation: managedObservationResultSchema.optional(),
    projectRecording: projectRecordingResultSchema.optional()
  })
  .strict()
export type ManagedExecutionResult = z.infer<typeof resultSchema>
const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)
const checksum = z.string().regex(/^[a-f0-9]{64}$/)
const provenanceSchema = z
  .object({
    rootFrameId: identity,
    agentFrameId: identity,
    messageBranchId: identity,
    runtimeSegmentId: identity,
    promptMessageId: identity
  })
  .strict()
const frozenOutputSchema = managedOutputSelectionSchema
  .extend({
    sha256: checksum,
    sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    generationId: identity.optional(),
    attempts: z.array(managedOutputWriteAttemptSchema).max(64),
    versionId: identity.optional()
  })
  .strict()
const collectionSchema = z
  .object({
    environmentId: checksum,
    provenance: provenanceSchema,
    selections: z.array(managedOutputSelectionSchema).max(100),
    transport: z.enum(['none', 'private-unix-socket']),
    frozen: z
      .object({
        runId: identity,
        status: z.enum(['completed', 'failed', 'cancelled']),
        exitCode: z.number().int().nullable(),
        files: z.array(frozenOutputSchema).max(100),
        missingOptionalOutputs: z.array(z.string()).max(100),
        missingCancelledOutputs: z.array(z.string()).max(100).optional()
      })
      .strict()
      .optional(),
    discarded: z.boolean().optional()
  })
  .strict()
const journalSchema = z
  .object({
    schemaVersion: z.literal(1),
    key: z.string().regex(/^[a-f0-9]{64}$/),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    projectId: z.string(),
    sessionId: z.string(),
    operationId: z.string(),
    requestId: z.string(),
    projectView: runtimeViewLaunchSchema.optional(),
    recordObservation: z.boolean().optional(),
    purpose: z.enum(['offline-demo', 'research']).optional(),
    demoViewing: runObservationDemoViewingAdmissionSchema.optional(),
    supplementalInputs: z
      .array(
        z
          .object({
            versionId: identity,
            sourceIdentity: z.string(),
            filename: z.string(),
            sha256: checksum,
            sizeBytes: z.number().int().nonnegative(),
            contentAvailable: z.boolean().optional(),
            descriptor: z.boolean().optional()
          })
          .strict()
      )
      .max(32)
      .optional(),
    executionProfile: z
      .object({
        profileId: identity,
        displayName: z.string(),
        variables: z.record(z.string(), z.string()),
        allowedNetworkHosts: z.array(z.string()),
        conditionChanges: z.array(z.string()),
        descriptorSha256: checksum,
        planKey: z.string()
      })
      .strict()
      .optional(),
    // Fail closed on recovery if credential-bearing outputs were not scanned before interruption.
    credentialOutputsChecked: z.boolean().optional(),
    observation: managedObservationResultSchema.optional(),
    projectRecording: projectRecordingResultSchema.optional(),
    state: z.enum(['running', 'awaiting-publication', 'completed', 'failed']),
    collection: collectionSchema.optional(),
    result: resultSchema.optional()
  })
  .strict()
  .refine((journal) => !journal.demoViewing || journal.purpose === 'offline-demo')
type Journal = z.infer<typeof journalSchema>

const inspectionTargetSchema = z
  .object({
    projectId: identity,
    sessionId: identity,
    operationId: identity.optional(),
    executionInvocationId: identity.optional(),
    runId: identity.optional()
  })
  .strict()
  .refine((value) => Boolean(value.operationId || value.executionInvocationId || value.runId))

export type ManagedExecutionInspection = {
  identity: {
    projectId: string
    sessionId: string
    operationId: string
    executionInvocationId: string
    environmentId?: string
    runId?: string
  }
  requestId: string
  state: Journal['state']
  purpose?: Journal['purpose']
  demoViewing?: Journal['demoViewing']
  executionProfile?: Pick<
    NonNullable<Journal['executionProfile']>,
    'displayName' | 'conditionChanges'
  >
  run: NotebookRunRecord | null
  artifacts: ArtifactVersionDescriptor[]
  projectView?: RuntimeViewLaunch
  /** Main-only evidence admission, consumed by the independent recording status reader. */
  recordObservation?: boolean
  observation?: ManagedObservationResult
  /** Main-private redaction inputs, never a public response. */
  secrets: string[]
}

export type ManagedServiceRegistration = {
  scope: RuntimeViewScope
  declaration: RuntimeViewLaunch
  socketPath: string
  proof: ManagedServiceProof
  logicalPort: number
  signal: AbortSignal
}

export type ManagedObservationMediaRegistration = {
  target: Required<RunObservationTarget>
  generationId: string
  recording: RunObservationRecordingHandle
  outputs: z.output<typeof managedOutputSelectionSchema>[]
  outputAuthority: ManagedOutputAuthority
  saveAuxiliaryOutput: NonNullable<ManagedExecutionTurnContext['saveAuxiliaryOutput']>
  signal: AbortSignal
}
export type ManagedProjectRecordingRegistration = {
  target: Required<
    Pick<RunObservationTarget, 'projectId' | 'sessionId' | 'operationId' | 'executionInvocationId'>
  > &
    Pick<RunObservationTarget, 'runId'>
  outputs: z.output<typeof managedOutputSelectionSchema>[]
  outputAuthority: ManagedOutputAuthority
  saveAuxiliaryOutput: NonNullable<ManagedExecutionTurnContext['saveAuxiliaryOutput']>
  signal: AbortSignal
}

export type ManagedExecutionServiceDependencies = {
  dataRoot: string
  profiles?: Pick<ResearchExecutionProfileStore, 'list' | 'save' | 'remove' | 'lease'>
  environments: Pick<
    ManagedResearchEnvironmentOwner,
    | 'prepare'
    | 'get'
    | 'release'
    | 'withExecution'
    | 'withCollection'
    | 'discardCollection'
    | 'acknowledgeCollection'
  >
  artifacts: Pick<ArtifactProvenanceRepository, 'resolveVersionDescriptors'> &
    Partial<Pick<ArtifactProvenanceRepository, 'replayVersion' | 'readPublishedVersionForWrite'>>
  /** Optional independent Main capture; enabled only by the recordObservation request option. */
  observation?: ManagedExecutionObservationPort
  notebooks: Pick<NotebookRunRepository, 'readSessionDocuments'>
  operations: Pick<SessionOperationOwner, 'start' | 'get' | 'wait' | 'cancel'>
  runtime: Pick<NotebookRuntimeService, 'executeManagedShell' | 'confirmManagedShellCleanup'>
  /** Optional Main integration; omitted for existing non-interactive executions. */
  registerProjectService?(service: ManagedServiceRegistration): () => void
  registerObservationMedia?(input: ManagedObservationMediaRegistration): { close(): Promise<void> }
  registerProjectRecording?(input: ManagedProjectRecordingRegistration):
    | {
        close(
          reason?: 'finished' | 'stopped' | 'interrupted'
        ): Promise<ManagedProjectRecordingResult>
      }
    | undefined
  /** Optional browser evidence, independent of Notebook/observation recording. */
  registerBrowserRecording?(input: ManagedProjectRecordingRegistration): {
    close(reason?: 'finished' | 'stopped' | 'interrupted'): Promise<void>
  }
  runtimes: {
    discover(): Promise<{
      runtimes: Array<{ runtimeId: string; runtime: ManagedResearchRuntime }>
      unavailable?: unknown[]
    }>
    resolve(runtimeId: string): Promise<ManagedResearchRuntime>
  }
  materials(request: {
    projectId: string
    sourceSessionId: string
    targetSessionId: string
    versionIds?: string[]
    expectedSourceIdentity?: string
    signal?: AbortSignal
  }): Promise<ResearchMaterialAuthority>
  // Resolve exact immutable Versions and recheck receipt hashes. Return honest turn-attached input
  // identities; restoration does not pretend that the runtime directly read an original archive.
  resolvePreparedInputs(receipt: ManagedResearchEnvironment): Promise<NotebookRunInputFile[]>
  createSession(
    request: CreateManagedSessionRequest
  ): Promise<{ projectId: string; sessionId: string }>
  withWritableSession<T>(
    scope: { projectId: string; sessionId: string },
    operation: () => Promise<T>
  ): Promise<T>
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const observationTarget = (journal: Journal): RunObservationTarget => ({
  projectId: journal.projectId,
  sessionId: journal.sessionId,
  operationId: journal.operationId,
  executionInvocationId: 'managed-' + journal.key
})
const publicRuntime = (
  runtime: ManagedResearchRuntime
): Omit<ManagedResearchRuntime, 'executable' | 'readOnlyRoots'> => {
  const { executable, readOnlyRoots, ...publicValue } = runtime
  void executable
  void readOnlyRoots
  return publicValue
}
const runtimeDiagnosticGuidance: Record<
  ManagedRuntimeDiagnosticCode,
  { message: string; action: string }
> = {
  node_not_found: {
    message:
      'No compatible independent Node runtime was found in the application search locations.',
    action:
      'Make an existing Node 22 or newer installation visible to the application, then restart Open Science and check again.'
  },
  node_version_unsupported: {
    message: 'A discovered Node runtime is older than the required version 22.',
    action:
      'Make an existing Node 22 or newer installation visible to the application, then restart Open Science and check again.'
  },
  node_host_mismatch: {
    message: 'A discovered Node runtime does not match this machine’s platform or architecture.',
    action: 'Select an independent Node 22 or newer installation built for this machine.'
  },
  node_not_independent: {
    message: 'A discovered executable is Electron, not an independent Node runtime.',
    action:
      'Make an independent Node 22 or newer installation visible to the application; Electron cannot substitute for it.'
  },
  node_unusable: {
    message: 'A discovered Node candidate could not be verified or probed successfully.',
    action:
      'Check that an independent Node 22 or newer native binary is executable and works on this machine, then restart Open Science and check again.'
  },
  native_service_unsupported: {
    message: 'Managed local HTTP services currently require native macOS.',
    action:
      'Use a native macOS host for plans requiring a local service. A discovered Node runtime alone does not establish service support.'
  }
}
const publicRuntimeDiagnostics = (
  available: boolean,
  unavailable: readonly unknown[]
): ManagedRuntimeDiagnostics => {
  const codes = new Set<ManagedRuntimeDiagnosticCode>()
  if (!available) {
    for (const item of unavailable) {
      const code = item && typeof item === 'object' && 'code' in item ? item.code : undefined
      codes.add(
        typeof code === 'string' &&
          code !== 'native_service_unsupported' &&
          Object.hasOwn(runtimeDiagnosticGuidance, code)
          ? (code as ManagedRuntimeDiagnosticCode)
          : 'node_unusable'
      )
    }
    if (codes.size === 0) codes.add('node_not_found')
    // Missing conventional locations add no useful diagnosis when an actual candidate failed.
    if (codes.size > 1) codes.delete('node_not_found')
  }
  const nativeServiceSupported = process.platform === 'darwin'
  if (!nativeServiceSupported) codes.add('native_service_unsupported')
  return {
    nativeServiceSupported,
    issues: [...codes].map((code) => ({ code, ...runtimeDiagnosticGuidance[code] }))
  }
}
const publicEnvironment = (receipt: ManagedResearchEnvironment): unknown => ({
  environmentId: receipt.environmentId,
  projectId: receipt.projectId,
  sessionId: receipt.sessionId,
  source: receipt.source,
  state: receipt.state,
  runtime: publicRuntime(receipt.runtime),
  inputs: receipt.prepared?.inputs ?? [],
  pendingCollection: receipt.pendingCollection,
  discardedCollections: receipt.discardedCollections,
  error: receipt.error
})

/** Shared execution core. Internal tools supply their current turn; external calls admit one. */
export class ManagedExecutionService {
  private readonly configurationBroker = new ResearchExecutionConfigurationBroker({
    preflight: (request, signal) => this.preflight(request, signal)
  })

  requestConfiguration(
    value: unknown,
    signal?: AbortSignal
  ): Promise<ResearchExecutionConfigurationSnapshot> {
    return this.configurationBroker.request(value, signal)
  }
  getConfiguration(
    value: unknown,
    signal?: AbortSignal
  ): Promise<ResearchExecutionConfigurationSnapshot> {
    return this.configurationBroker.get(value, signal)
  }
  pendingConfigurations(): ResearchExecutionConfigurationSnapshot[] {
    return this.configurationBroker.listPending()
  }
  resolveConfiguration(
    value: unknown,
    signal?: AbortSignal
  ): Promise<ResearchExecutionConfigurationSnapshot> {
    return this.configurationBroker.resolve(value, signal)
  }

  private readonly liveOutput = new Map<
    string,
    {
      runId?: string
      stdout: string
      stderr: string
      truncated: boolean
      secrets: string[]
    }
  >()
  private readonly publicationCandidates = new Map<
    string,
    { projectId: string; sessionId: string }
  >()
  private readonly publicationChecks = new Map<string, Promise<boolean>>()
  private readonly active = new Map<
    string,
    { fingerprint: string; completion: Promise<ManagedExecutionResult> }
  >()

  private readonly offlinePlans: OfflinePlanAdmission

  constructor(private readonly dependencies: ManagedExecutionServiceDependencies) {
    this.offlinePlans = new OfflinePlanAdmission({ ...dependencies, service: this })
  }

  private get observation(): ManagedExecutionObservationPort {
    if (!this.dependencies.observation)
      throw new Error('Run observation is not available in this runtime.')
    return this.dependencies.observation
  }

  /** Read-only exact admission lookup. No executor, Session, environment or process is created. */
  async inspectExecution(value: unknown): Promise<ManagedExecutionInspection | undefined> {
    const target = inspectionTargetSchema.parse(value)
    const runs = (
      await this.dependencies.notebooks.readSessionDocuments(target.projectId, target.sessionId)
    ).flatMap((document) => document.runs)
    let invocation = target.executionInvocationId
    if (target.runId) {
      const selected = runs.filter((run) => run.runId === target.runId)
      if (selected.length !== 1 || !selected[0].executionInvocationId) return undefined
      if (invocation && selected[0].executionInvocationId !== invocation) return undefined
      invocation = selected[0].executionInvocationId
    }
    let keys: string[]
    if (invocation) {
      if (!/^managed-[a-f0-9]{64}$/.test(invocation)) return undefined
      keys = [invocation.slice('managed-'.length)]
    } else {
      let names: string[]
      try {
        names = await readdir(join(this.dependencies.dataRoot, 'managed-execution-requests'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
      keys = names
        .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
        .map((name) => name.slice(0, -5))
      if (keys.length > 10000)
        throw new Error('Select an exact execution invocation to inspect this Run.')
    }
    const candidates: Journal[] = []
    for (const key of keys) {
      const journal = await this.readJournal(key)
      if (
        journal &&
        journal.projectId === target.projectId &&
        journal.sessionId === target.sessionId &&
        (!target.operationId || target.operationId === journal.operationId)
      )
        candidates.push(journal)
    }
    if (candidates.length > 1)
      throw new Error('This operation contains multiple executions. Select a Run or invocation.')
    const journal = candidates[0]
    if (!journal) return undefined
    const executionInvocationId = 'managed-' + journal.key
    const matches = runs.filter((run) => run.executionInvocationId === executionInvocationId)
    if (matches.length > 1) throw new Error('The execution has ambiguous Notebook Run evidence.')
    let run = matches[0] ? structuredClone(matches[0]) : null
    const live = this.liveOutput.get(journal.key)
    if (run && live?.runId === run.runId && ['queued', 'running'].includes(run.status)) {
      run = {
        ...run,
        text: { ...run.text, stdout: live.stdout, stderr: live.stderr },
        truncated: run.truncated || live.truncated
      }
    }
    const artifacts: ArtifactVersionDescriptor[] = []
    const outputs = journal.result?.outputs ?? []
    for (let offset = 0; offset < outputs.length; offset += MAX_ARTIFACT_VERSION_DESCRIPTOR_IDS) {
      const batch = outputs.slice(offset, offset + MAX_ARTIFACT_VERSION_DESCRIPTOR_IDS)
      const versions = await this.dependencies.artifacts.resolveVersionDescriptors({
        projectId: target.projectId,
        appSessionId: target.sessionId,
        versionIds: batch.map((output) => output.versionId)
      })
      artifacts.push(
        ...versions.filter(
          (version) =>
            version.projectId === target.projectId &&
            version.sessionId === target.sessionId &&
            version.state === 'finalized' &&
            version.isPublished === true &&
            batch.some(
              (output) => output.versionId === version.versionId && output.filename === version.name
            )
        )
      )
    }
    return {
      identity: {
        projectId: journal.projectId,
        sessionId: journal.sessionId,
        operationId: journal.operationId,
        executionInvocationId,
        ...(journal.collection ? { environmentId: journal.collection.environmentId } : {}),
        ...(run ? { runId: run.runId } : {})
      },
      requestId: journal.requestId,
      state: journal.state,
      purpose: journal.purpose,
      ...(journal.purpose === 'offline-demo' && journal.demoViewing
        ? { demoViewing: journal.demoViewing }
        : {}),
      ...(journal.executionProfile
        ? {
            executionProfile: {
              displayName: journal.executionProfile.displayName,
              conditionChanges: [...journal.executionProfile.conditionChanges]
            }
          }
        : {}),
      run,
      artifacts,
      ...(journal.recordObservation ? { recordObservation: true } : {}),
      ...(journal.observation ? { observation: structuredClone(journal.observation) } : {}),
      ...(journal.projectView ? { projectView: journal.projectView } : {}),
      secrets: [...(live?.secrets ?? [])]
    }
  }

  async runtimes(): Promise<{
    available: boolean
    runtimes: Array<ReturnType<typeof publicRuntime> & { runtimeId: string }>
    diagnostics?: ManagedRuntimeDiagnostics
  }> {
    const discovered = await this.dependencies.runtimes.discover()
    const available = discovered.runtimes.length > 0
    return {
      runtimes: discovered.runtimes.map(({ runtimeId, runtime }) => ({
        runtimeId,
        ...publicRuntime(runtime)
      })),
      available,
      diagnostics: publicRuntimeDiagnostics(available, discovered.unavailable ?? [])
    }
  }

  async createSession(value: unknown): Promise<{ projectId: string; sessionId: string }> {
    return this.dependencies.createSession(createManagedSessionRequestSchema.parse(value))
  }

  async inspectMaterials(value: unknown, signal?: AbortSignal): Promise<unknown> {
    const request = inspectManagedMaterialsRequestSchema.parse(value)
    return this.dependencies.withWritableSession(request, async () => {
      const authority = await this.dependencies.materials({
        projectId: request.projectId,
        sourceSessionId: request.sourceSessionId,
        targetSessionId: request.sessionId,
        versionIds: request.versionIds,
        expectedSourceIdentity: request.sourceIdentity,
        signal
      })
      return {
        ...(await inspectResearchMaterials(authority, {
          descriptorVersionId: request.descriptorVersionId,
          signal
        })),
        versions: authority.versions
      }
    })
  }

  private async inspectExecutionPlan(
    value: unknown,
    signal?: AbortSignal
  ): Promise<{
    request: ResearchExecutionPreflightRequest
    inspection: Awaited<ReturnType<typeof inspectResearchMaterials>>
    plan:
      | import('../../shared/research-reproduction').ResearchReproductionDescription['plans'][number]
      | undefined
    binding: ResearchExecutionBinding | undefined
    slots: ResearchExecutionSecretSlot[]
  }> {
    const request = researchExecutionPreflightRequestSchema.parse(value)
    const authority = await this.dependencies.materials({
      projectId: request.projectId,
      targetSessionId: request.sessionId,
      sourceSessionId: request.sourceSessionId,
      expectedSourceIdentity: request.sourceIdentity,
      signal
    })
    const inspection = await inspectResearchMaterials(authority, {
      descriptorVersionId: request.descriptorVersionId,
      signal
    })
    const plan = inspection.description?.plans.find((item) => item.key === request.planKey)
    const binding: ResearchExecutionBinding | undefined =
      inspection.descriptor && plan
        ? {
            projectId: request.projectId,
            sourceSessionId: request.sourceSessionId,
            sourceIdentity: authority.source.identity,
            descriptorVersionId: inspection.descriptor.versionId,
            descriptorSha256: inspection.descriptor.sha256,
            planKey: plan.key
          }
        : undefined
    const slots: ResearchExecutionSecretSlot[] =
      inspection.description?.secrets?.filter((slot) => slot.planKeys.includes(request.planKey)) ??
      []
    return { request, inspection, plan, binding, slots }
  }

  /** Read-only Agent/SDK discovery; never installs, executes, or substitutes a demo. */
  async preflight(value: unknown, signal?: AbortSignal): Promise<ResearchExecutionPreflight> {
    const request = researchExecutionPreflightRequestSchema.parse(value)
    return this.dependencies.withWritableSession(request, async () => {
      const { inspection, plan, binding, slots } = await this.inspectExecutionPlan(request, signal)
      const result: ResearchExecutionPreflight = {
        status: 'blocked',
        issues: [],
        compatibleRuntimeIds: [],
        profiles: [],
        slots: [],
        remoteServicesVerified: false
      }
      if (inspection.status !== 'ready') result.issues.push({ code: 'description-unavailable' })
      if (!plan || !binding) {
        result.issues.push({ code: 'plan-unavailable' })
        return result
      }
      result.binding = binding
      result.sourceTitle = inspection.source.title
      result.planTitle = plan.title
      for (const key of plan.materialKeys)
        if (inspection.materials?.find((item) => item.key === key)?.status !== 'available')
          result.issues.push({ code: 'material-unavailable', key })
      const runtimes = await this.runtimes()
      result.compatibleRuntimeIds = runtimes.runtimes
        .filter(
          (runtime) =>
            runtime.platform === 'darwin' &&
            (!plan.requirements?.platforms ||
              plan.requirements.platforms.includes(runtime.platform)) &&
            (!plan.requirements?.node ||
              (validRange(plan.requirements.node) !== null &&
                satisfies(runtime.version, plan.requirements.node)))
        )
        .map((runtime) => runtime.runtimeId)
      if (!result.compatibleRuntimeIds.length) result.issues.push({ code: 'runtime-unavailable' })
      result.profiles = (await this.dependencies.profiles?.list(binding)) ?? []
      const profile = request.profileId
        ? result.profiles.find((item) => item.profileId === request.profileId)
        : undefined
      if (request.profileId && !profile) result.issues.push({ code: 'profile-unavailable' })
      if (!profile && slots.some((slot) => slot.required))
        result.issues.push({ code: 'profile-required' })
      let inaccessible = false
      if (profile) {
        result.selectedProfileId = profile.profileId
        try {
          // Missing slots are not a credential-storage failure.
          if (
            !slots.some(
              (slot) => slot.required && !profile.configuredCredentialKeys.includes(slot.key)
            )
          ) {
            const lease = await this.dependencies.profiles!.lease(profile.profileId, binding, slots)
            lease.release()
          }
        } catch {
          inaccessible = true
          result.issues.push({ code: 'credential-unavailable' })
        }
      }
      result.slots = slots.map((slot) => {
        if (!researchEnvironmentVariableSchema.safeParse(slot.environmentVariable).success) {
          result.issues.push({ code: 'credential-unavailable', key: slot.key })
          return { ...slot, status: 'unavailable' }
        }
        const configured = profile?.configuredCredentialKeys.includes(slot.key)
        if (slot.required && !configured)
          result.issues.push({ code: 'credential-required', key: slot.key })
        return {
          ...slot,
          status: configured ? (inaccessible ? 'unavailable' : 'configured') : 'missing'
        }
      })
      result.status = result.issues.length ? 'blocked' : 'ready'
      return result
    })
  }

  /** Trusted desktop only. Deliberately absent from external and Agent method catalogs. */
  async saveExecutionProfile(
    value: unknown,
    signal?: AbortSignal
  ): Promise<ResearchExecutionProfileView> {
    if (!this.dependencies.profiles) throw new Error('Local research profiles are unavailable.')
    const request = saveResearchExecutionProfileRequestSchema.parse(value)
    return this.dependencies.withWritableSession(request, async () => {
      const { binding, slots } = await this.inspectExecutionPlan(
        {
          projectId: request.projectId,
          sessionId: request.sessionId,
          sourceSessionId: request.sourceSessionId,
          sourceIdentity: request.sourceIdentity,
          descriptorVersionId: request.descriptorVersionId,
          planKey: request.planKey,
          profileId: request.profileId
        },
        signal
      )
      if (!binding) throw new Error('The research plan is unavailable.')
      signal?.throwIfAborted()
      return this.dependencies.profiles!.save(request, binding, slots, signal)
    })
  }

  async removeExecutionProfile(value: unknown, signal?: AbortSignal): Promise<void> {
    const request = researchExecutionPreflightRequestSchema.parse(value)
    if (!request.profileId || !this.dependencies.profiles)
      throw new Error('Research profile not found.')
    await this.dependencies.withWritableSession(request, async () => {
      const { binding } = await this.inspectExecutionPlan(request, signal)
      if (!binding) throw new Error('The research plan is unavailable.')
      signal?.throwIfAborted()
      await this.dependencies.profiles!.remove(request.profileId!, binding, signal)
    })
  }

  private async verifySupplementalInputs(
    request: z.output<typeof executeManagedEnvironmentRequestSchema>,
    ids: string[],
    signal?: AbortSignal
  ): Promise<ResearchMaterialVersion[]> {
    if (!ids.length) return []
    if (new Set(ids).size !== ids.length)
      throw new Error('Supplemental research inputs must be unique.')
    const environment = await this.dependencies.environments.get(request)
    const authority = await this.dependencies.materials({
      projectId: request.projectId,
      targetSessionId: request.sessionId,
      sourceSessionId: environment.source.sessionId,
      expectedSourceIdentity: environment.source.identity,
      signal
    })
    const inputs: ResearchMaterialVersion[] = []
    for (const id of ids) {
      const version = authority.versions.find((item) => item.versionId === id)
      if (
        !version ||
        version.sourceIdentity !== environment.source.identity ||
        version.contentAvailable === false ||
        version.sizeBytes > 512 * 1024
      )
        throw new Error('The supplemental research input is unavailable in the selected source.')
      const bytes = await authority.readVersion(id, { maxBytes: 512 * 1024, signal })
      signal?.throwIfAborted()
      if (
        bytes.byteLength !== version.sizeBytes ||
        createHash('sha256').update(bytes).digest('hex') !== version.sha256
      )
        throw new Error('The supplemental research input failed verification.')
      inputs.push({ ...version })
    }
    return inputs
  }

  private async acquireExecutionProfile(
    request: z.output<typeof executeManagedEnvironmentRequestSchema>
  ): Promise<ResearchExecutionCredentialLease | undefined> {
    if (!request.profileId) return undefined
    if (!this.dependencies.profiles) throw new Error('Local research profiles are unavailable.')
    const environment = await this.dependencies.environments.get(request)
    const descriptor = environment.prepared?.inputs.find(
      (input) => input.descriptor || input.filename === 'research-reproduction.json'
    )
    if (!descriptor) throw new Error('A research profile requires a prepared research description.')
    const authority = await this.dependencies.materials({
      projectId: request.projectId,
      targetSessionId: request.sessionId,
      sourceSessionId: environment.source.sessionId,
      expectedSourceIdentity: environment.source.identity
    })
    const inspection = await inspectResearchMaterials(authority, {
      descriptorVersionId: descriptor.versionId
    })
    if (inspection.descriptor?.sha256 !== descriptor.sha256 || !inspection.description)
      throw new Error('The prepared research description changed.')
    for (const plan of inspection.description.plans) {
      const binding = {
        projectId: request.projectId,
        sourceSessionId: environment.source.sessionId,
        sourceIdentity: environment.source.identity,
        descriptorVersionId: descriptor.versionId,
        descriptorSha256: descriptor.sha256,
        planKey: plan.key
      }
      if (
        !(await this.dependencies.profiles.list(binding)).some(
          (profile) => profile.profileId === request.profileId
        )
      )
        continue
      if (
        plan.materialKeys.some(
          (key) => !environment.prepared?.inputs.some((input) => input.materialKey === key)
        )
      )
        throw new Error(
          'The prepared environment does not include this profile’s research materials.'
        )
      if (
        environment.runtime.platform !== 'darwin' ||
        (plan.requirements?.platforms &&
          !plan.requirements.platforms.includes(environment.runtime.platform)) ||
        (plan.requirements?.node &&
          (validRange(plan.requirements.node) === null ||
            !satisfies(environment.runtime.version, plan.requirements.node)))
      )
        throw new Error('The prepared runtime does not satisfy the research profile plan.')
      return this.dependencies.profiles.lease(
        request.profileId,
        binding,
        inspection.description.secrets?.filter((slot) => slot.planKeys.includes(plan.key)) ?? []
      )
    }
    throw new Error('The execution profile does not match these prepared research materials.')
  }

  async prepare(value: unknown, signal?: AbortSignal): Promise<unknown> {
    const request = prepareManagedEnvironmentRequestSchema.parse(value)
    return this.dependencies.withWritableSession(request, async () => {
      const authority = await this.dependencies.materials({
        projectId: request.projectId,
        sourceSessionId: request.sourceSessionId,
        targetSessionId: request.sessionId,
        versionIds: request.versionIds,
        expectedSourceIdentity: request.sourceIdentity,
        signal
      })
      const runtime = await this.dependencies.runtimes.resolve(request.runtimeId)
      return publicEnvironment(
        await this.dependencies.environments.prepare({
          projectId: request.projectId,
          sessionId: request.sessionId,
          requestId: request.requestId,
          authority,
          materials: request.materials,
          runtime,
          signal
        })
      )
    })
  }

  async getEnvironment(value: unknown): Promise<unknown> {
    const request = managedEnvironmentReferenceSchema.parse(value)
    await this.reconcileEnvironment(request)
    return publicEnvironment(await this.dependencies.environments.get(request))
  }

  async releaseEnvironment(value: unknown): Promise<unknown> {
    const request = managedEnvironmentReferenceSchema.parse(value)
    await this.reconcileEnvironment(request)
    return publicEnvironment(await this.dependencies.environments.release(request))
  }

  private async reconcileEnvironment(
    request: z.infer<typeof managedEnvironmentReferenceSchema>
  ): Promise<void> {
    const environment = await this.dependencies.environments.get(request)
    if (!environment.pendingCollection) return
    const journal = await this.requireCollection({
      ...request,
      collectionId: environment.pendingCollection.collectionId
    })
    if (journal.result) await this.reconcileCollection(journal)
  }

  /** The existing Artifact publication hook is a hint; exact durable Versions remain authority. */
  async reconcilePublishedOutputs(scope?: { projectId: string; sessionId: string }): Promise<void> {
    await this.dependencies.observation?.reconcilePublished(scope)
    if (!scope) {
      let names: string[]
      try {
        names = await readdir(join(this.dependencies.dataRoot, 'managed-execution-requests'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      for (const name of names) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
        const journal = await this.readJournal(name.slice(0, -5))
        if (journal?.collection && journal.result && !journal.collection.discarded)
          this.publicationCandidates.set(journal.key, journal)
      }
    }
    for (const [key, candidate] of this.publicationCandidates) {
      if (
        scope &&
        (candidate.projectId !== scope.projectId || candidate.sessionId !== scope.sessionId)
      )
        continue
      const journal = await this.readJournal(key)
      if (!journal?.result || !journal.collection || journal.collection.discarded) {
        this.publicationCandidates.delete(key)
        continue
      }
      const environment = await this.dependencies.environments.get({
        ...candidate,
        environmentId: journal.collection.environmentId
      })
      if (
        environment.pendingCollection?.collectionId !== key ||
        environment.discardedCollections?.some((entry) => entry.collectionId === key)
      ) {
        this.publicationCandidates.delete(key)
        continue
      }
      await this.dependencies.withWritableSession(candidate, async () => {
        await this.reconcileCollection(journal)
      })
    }
  }

  private reconcileCollection(journal: Journal): Promise<boolean> {
    const existing = this.publicationChecks.get(journal.key)
    if (existing) return existing
    const completion = this.confirmPublishedCollection(journal).finally(() => {
      if (this.publicationChecks.get(journal.key) === completion)
        this.publicationChecks.delete(journal.key)
    })
    this.publicationChecks.set(journal.key, completion)
    return completion
  }

  private async confirmPublishedCollection(journal: Journal): Promise<boolean> {
    if (!journal.result || !journal.collection || journal.collection.discarded) return false
    this.publicationCandidates.set(journal.key, journal)
    await this.refreshObservation(journal)
    // The original Run owns its output retention fence. Optional capture owns a separate durable
    // publication receipt, so a capture failure cannot retain the execution environment forever.
    const outputs = journal.result.outputs.filter(
      (output) =>
        !(
          journal.recordObservation &&
          output.versionId === journal.observation?.versionId &&
          output.filename === `replay-${journal.observation.recordingId}.json`
        )
    )
    for (let offset = 0; offset < outputs.length; offset += MAX_ARTIFACT_VERSION_DESCRIPTOR_IDS) {
      const batch = outputs.slice(offset, offset + MAX_ARTIFACT_VERSION_DESCRIPTOR_IDS)
      const versions = await this.dependencies.artifacts.resolveVersionDescriptors({
        projectId: journal.projectId,
        appSessionId: journal.sessionId,
        versionIds: batch.map((output) => output.versionId)
      })
      if (
        batch.some(
          (output) =>
            !versions.some(
              (version) =>
                version.versionId === output.versionId &&
                version.projectId === journal.projectId &&
                version.sessionId === journal.sessionId &&
                version.name === output.filename &&
                version.state === 'finalized' &&
                version.isPublished === true
            )
        )
      )
        return false
    }
    const reference = {
      projectId: journal.projectId,
      sessionId: journal.sessionId,
      environmentId: journal.collection.environmentId
    }
    const environment = await this.dependencies.environments.get(reference)
    if (environment.discardedCollections?.some((entry) => entry.collectionId === journal.key)) {
      this.publicationCandidates.delete(journal.key)
      return false
    }
    // Commit publication proof before releasing the retention fence. A crash leaves either an
    // awaiting journal with retained bytes, or a completed journal whose acknowledgment can retry.
    const current = await this.readJournal(journal.key)
    if (current && !current.collection?.discarded) {
      current.state = 'completed'
      if (journal.observation) {
        current.observation = journal.observation
        if (current.result) current.result.observation = journal.observation
      }
      await this.writeJournal(current)
    }
    // A completed A may be queried while B is pending. Never acknowledge B using A's Versions.
    if (environment.pendingCollection?.collectionId === journal.key)
      await this.dependencies.environments.acknowledgeCollection({
        ...reference,
        collectionId: journal.key
      })
    this.publicationCandidates.delete(journal.key)
    return true
  }

  async collectOutputs(value: unknown): ReturnType<SessionOperationOwner['start']> {
    const request = collectManagedOutputsRequestSchema.parse(value)
    return this.dependencies.operations.start({
      ...request,
      requestFingerprint: digest(JSON.stringify(['collect-outputs', request])),
      requestText: 'Collect retained outputs from an earlier execution without running it again.',
      execute: async (context, signal) => {
        const result = await this.collectOutputsInTurn(request, context, signal)
        return {
          status: 'completed',
          text: `Collected ${result.outputs.length} outputs from the original Notebook Run ${result.runId}. No command was executed.`
        }
      }
    })
  }

  async discardOutputs(value: unknown): Promise<unknown> {
    const request = managedCollectionReferenceSchema.parse(value)
    return this.dependencies.withWritableSession(request, async () => {
      const journal = await this.requireCollection(request)
      // The environment owner durably records explicit discard before clearing retention. A
      // failed journal update can be retried against that exact discard record without execution.
      const receipt = await this.dependencies.environments.discardCollection(request)
      journal.collection!.discarded = true
      await this.writeJournal(journal)
      return publicEnvironment(receipt)
    })
  }

  async collectOutputsInTurn(
    value: unknown,
    admittedContext: ManagedExecutionTurnContext,
    signal?: AbortSignal
  ): Promise<ManagedExecutionResult> {
    const request = collectManagedOutputsRequestSchema.parse(value)
    const context: ManagedExecutionTurnContext = Object.freeze({
      operationId: admittedContext.operationId,
      executionInvocationId: admittedContext.executionInvocationId,
      projectId: admittedContext.projectId,
      sessionId: admittedContext.sessionId,
      workspaceCwd: admittedContext.workspaceCwd,
      provenanceContext: Object.freeze({ ...admittedContext.provenanceContext }),
      recordRun: admittedContext.recordRun.bind(admittedContext),
      saveOutput: admittedContext.saveOutput.bind(admittedContext),
      ...(admittedContext.saveAuxiliaryOutput
        ? { saveAuxiliaryOutput: admittedContext.saveAuxiliaryOutput.bind(admittedContext) }
        : {}),
      recoverOutput: admittedContext.recoverOutput.bind(admittedContext)
    })
    if (request.projectId !== context.projectId || request.sessionId !== context.sessionId)
      throw new Error('Retained outputs do not belong to the admitted Session.')
    return this.dependencies.withWritableSession(request, async () => {
      const journal = await this.requireCollection(request)
      if (journal.collection!.discarded)
        throw new Error('Retained outputs were explicitly discarded.')
      const current = provenanceSchema.parse(context.provenanceContext)
      if (
        current.rootFrameId !== current.agentFrameId ||
        ['rootFrameId', 'agentFrameId', 'messageBranchId'].some(
          (key) =>
            current[key as keyof typeof current] !==
            journal.collection!.provenance[key as keyof typeof current]
        )
      )
        throw new Error('Retained output collection requires the original Main Agent branch.')
      if (journal.result) {
        if (!(await this.reconcileCollection(journal)))
          throw new Error(
            'Saved outputs are awaiting publication by their original conversation turn. The environment is retained; finish or recover that turn before collecting again. No command was executed.'
          )
        if (
          journal.recordObservation &&
          ['ready', 'pending', 'failed', 'unavailable'].includes(journal.observation?.status ?? '')
        ) {
          await this.publishObservation(journal, context, journal.result.outputs, true)
          journal.result.observation = journal.observation
          await this.writeJournal(journal)
        }
        // A newly saved capture is successful work in this turn. Return normally so the existing
        // Artifact owner can finalize/publish it; its own receipt reports awaiting publication.
        return journal.result
      }
      return this.dependencies.environments.withCollection(
        { ...request, operationId: context.operationId, signal, retainCollection: true },
        async (environment) => {
          await this.freezeCollection(journal, context, environment.authority, environment.signal)
          return this.publishCollection(
            journal,
            context,
            environment.receipt,
            environment.authority,
            environment.signal,
            true
          )
        }
      )
    })
  }

  private journalPath(key: string): string {
    return join(this.dependencies.dataRoot, 'managed-execution-requests', key + '.json')
  }

  private async readJournal(key: string): Promise<Journal | undefined> {
    checksum.parse(key)
    const existing = await readDurableJsonFile(
      this.journalPath(key),
      (text) => {
        const parsed = journalSchema.safeParse(JSON.parse(text))
        if (
          !parsed.success ||
          parsed.data.key !== key ||
          digest(
            JSON.stringify([
              parsed.data.projectId,
              parsed.data.sessionId,
              parsed.data.operationId,
              parsed.data.requestId
            ])
          ) !== key
        )
          throw new DurableJsonRecoveryBarrierError('Invalid managed execution request receipt.')
        return parsed.data
      },
      {},
      { maxBytes: 8 * 1024 * 1024 }
    )
    return existing.status === 'found' ? existing.value : undefined
  }

  private async writeJournal(journal: Journal): Promise<void> {
    const text = JSON.stringify(journalSchema.parse(journal))
    if (Buffer.byteLength(text) > 8 * 1024 * 1024)
      throw new Error('Managed output collection receipt exceeds its storage budget.')
    await writeDurableJsonFile(this.journalPath(journal.key), text)
  }

  private async requireCollection(
    request: z.infer<typeof managedCollectionReferenceSchema>
  ): Promise<Journal> {
    const journal = await this.readJournal(request.collectionId)
    if (
      !journal?.collection ||
      journal.projectId !== request.projectId ||
      journal.sessionId !== request.sessionId ||
      journal.collection.environmentId !== request.environmentId
    )
      throw new Error('No matching retained output collection was recorded.')
    return journal
  }

  private async checkCredentialOutputs(
    journal: Journal,
    context: ManagedExecutionTurnContext,
    authority: ManagedOutputAuthority,
    secrets: readonly string[],
    signal: AbortSignal
  ): Promise<void> {
    if (!journal.executionProfile) return
    // Freeze ownership and terminal status first. Cancellation may legitimately leave declared
    // outputs unproduced; only the exact files that will be published need credential screening.
    if (!journal.collection?.frozen)
      throw new Error('Research outputs must be frozen before screening.')
    for (const selection of journal.collection.frozen.files) {
      const file = await resolveManagedOutputAuthority(authority, context, selection.path)
      // Streaming bounded-memory scan; include common encodings that might otherwise leak in exports.
      const patterns = configuredCredentialPatterns(secrets)
      if (!patterns.length) continue
      const overlap = Math.max(...patterns.map((pattern) => pattern.length)) - 1
      const handle = await open(file.path, 'r')
      try {
        const buffer = Buffer.alloc(64 * 1024)
        let tail = Buffer.alloc(0)
        while (true) {
          signal.throwIfAborted()
          const { bytesRead } = await handle.read(buffer)
          if (!bytesRead) break
          const bytes = Buffer.concat([tail, buffer.subarray(0, bytesRead)])
          if (patterns.some((pattern) => bytes.includes(pattern)))
            throw new Error(
              'A research output contains a configured credential. Publication was stopped; correct the program or discard the retained output.'
            )
          tail = bytes.subarray(Math.max(0, bytes.length - overlap))
        }
      } finally {
        await handle.close()
      }
    }
    journal.credentialOutputsChecked = true
    await this.writeJournal(journal)
  }

  private async freezeCollection(
    journal: Journal,
    context: ManagedExecutionTurnContext,
    authority: ManagedOutputAuthority,
    signal: AbortSignal
  ): Promise<void> {
    const collection = journal.collection!
    if (collection.frozen) return
    const invocation = 'managed-' + journal.key
    const matches = (
      await this.dependencies.notebooks.readSessionDocuments(journal.projectId, journal.sessionId)
    )
      .flatMap(({ runs }) => runs)
      .filter(
        (run) => run.submissionIdentity === invocation && run.executionInvocationId === invocation
      )
    if (matches.length !== 1)
      throw new Error('Retained output collection requires exactly one recorded execution.')
    const run = matches[0]
    if (
      run.kernelKind !== 'bash' ||
      run.status === 'queued' ||
      run.status === 'running' ||
      Object.entries(collection.provenance).some(
        ([key, value]) => run[key as keyof typeof run] !== value
      )
    )
      throw new Error('Retained output producer is not the original terminal Notebook Run.')
    const files: z.infer<typeof frozenOutputSchema>[] = []
    const missingOptionalOutputs: string[] = []
    const missingCancelledOutputs: string[] = []
    for (const selection of collection.selections) {
      signal.throwIfAborted()
      let managed: Awaited<ReturnType<typeof resolveManagedOutputAuthority>>
      try {
        managed = await resolveManagedOutputAuthority(authority, context, selection.path)
      } catch (error) {
        if (selection.optional && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          missingOptionalOutputs.push(selection.path)
          continue
        }
        if (run.status === 'cancelled' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          // An explicit stop is a terminal outcome, not a demand to manufacture every planned
          // result. Keep this distinct from optional outputs, and never weaken completed Runs.
          missingCancelledOutputs.push(selection.path)
          continue
        }
        throw error
      }
      const expectedPath = `data/managed-execution/${collection.environmentId}/files/${selection.path}`
      const matchingFiles = run.workingFiles.filter(
        (file) => file.relativePath === expectedPath && file.createdByRunId === run.runId
      )
      if (matchingFiles.length !== 1 || matchingFiles[0].size === undefined)
        throw new Error('Retained output has no unique owned file in its original Notebook Run.')
      const file = matchingFiles[0]
      const observed = await digestFileWithinBudget(managed.path, file.size!, signal)
      if (
        (file.checksum !== undefined && observed.checksum !== file.checksum) ||
        observed.sizeBytes !== file.size
      )
        throw new Error('Retained output bytes differ from the original recorded generation.')
      files.push(
        frozenOutputSchema.parse({
          ...selection,
          sha256: observed.checksum,
          sizeBytes: observed.sizeBytes,
          generationId: file.checksum ? file.generationId : undefined,
          attempts: []
        })
      )
    }
    collection.frozen = {
      runId: run.runId,
      status:
        run.status === 'completed'
          ? 'completed'
          : run.status === 'cancelled'
            ? 'cancelled'
            : 'failed',
      exitCode: run.exitCode ?? null,
      files,
      missingOptionalOutputs,
      ...(missingCancelledOutputs.length ? { missingCancelledOutputs } : {})
    }
    await this.writeJournal(journal)
  }

  private async publishObservation(
    journal: Journal,
    context: ManagedExecutionTurnContext,
    outputs: ManagedExecutionResult['outputs'],
    recovery: boolean,
    handle?: RunObservationRecordingHandle
  ): Promise<void> {
    if (!journal.recordObservation) return
    const files = journal.collection?.frozen?.files ?? []
    const publication = await this.observation.publish({
      target: observationTarget(journal),
      context,
      handle,
      recovery,
      reservedFilenames: files.map((file) => file.filename),
      media: files.flatMap((file) =>
        file.versionId
          ? [
              {
                mediaKey: 'output-' + digest(file.filename),
                name: file.filename,
                mimeType: file.contentType ?? 'application/octet-stream',
                checksum: file.sha256,
                sizeBytes: file.sizeBytes,
                sourceVersionId: file.versionId,
                stepKeys: []
              }
            ]
          : []
      )
    })
    journal.observation = publication.result
    if (
      publication.output &&
      !outputs.some(
        (item) =>
          item.filename === publication.output!.filename &&
          item.versionId === publication.output!.versionId
      )
    )
      outputs.push(publication.output)
  }

  private async refreshObservation(journal: Journal): Promise<void> {
    // A read on an installation without the optional adapter preserves the original evidence.
    // It must neither relabel a stored capture nor manufacture publication confirmation.
    if (!journal.recordObservation || !this.dependencies.observation) return
    const current = await this.observation.confirm(observationTarget(journal))
    if (current) journal.observation = current
    if (journal.result && journal.observation) journal.result.observation = journal.observation
  }

  private async publishCollection(
    journal: Journal,
    context: ManagedExecutionTurnContext,
    environment: ManagedResearchEnvironment,
    authority: ManagedOutputAuthority,
    signal: AbortSignal,
    recovery: boolean,
    observationHandle?: RunObservationRecordingHandle
  ): Promise<ManagedExecutionResult> {
    const collection = journal.collection!
    if (journal.executionProfile && !journal.credentialOutputsChecked)
      throw new Error(
        'Research outputs require credential screening before publication; discard this retained collection if screening was interrupted.'
      )
    const frozen = collection.frozen!
    if (recovery && frozen.files.some((file) => !file.generationId))
      throw new Error(
        'Retained output recovery requires captured original file generations. Preserve the outputs for inspection or explicitly discard them.'
      )
    const recoveryAuthority = recovery
      ? createManagedOutputRecoveryAuthority({
          projectId: journal.projectId,
          sessionId: journal.sessionId,
          operationId: context.operationId,
          collectionId: journal.key,
          producerRunId: frozen.runId,
          producerProvenance: collection.provenance,
          outputs: frozen.files.map(({ filename, path, sha256, sizeBytes, generationId }) => ({
            filename,
            path,
            sha256,
            sizeBytes,
            generationId: generationId!
          })),
          signal
        })
      : undefined
    const outputs: ManagedExecutionResult['outputs'] = []
    try {
      for (const file of frozen.files) {
        const beforeWrite = async (attempt: ManagedOutputWriteAttempt): Promise<void> => {
          if (
            attempt.source.sha256 !== file.sha256 ||
            attempt.source.sizeBytes !== file.sizeBytes ||
            attempt.source.generationId !== file.generationId ||
            attempt.source.relativePath !== file.path ||
            attempt.request.producerRunId !== frozen.runId ||
            attempt.request.filename !== file.filename ||
            attempt.request.projectId !== journal.projectId ||
            attempt.request.appSessionId !== journal.sessionId
          )
            throw new Error('Publication bytes differ from the frozen output collection.')
          if (file.attempts.length >= 64)
            throw new Error(
              'Retained output has too many publication attempts; keep its evidence for inspection.'
            )
          file.attempts.push(managedOutputWriteAttemptSchema.parse(attempt))
          await this.writeJournal(journal)
        }
        const output = {
          filename: file.filename,
          contentType: file.contentType,
          producerRunId: frozen.runId,
          source: { kind: 'managedOutput' as const, authority, path: file.path },
          publication: { beforeWrite }
        }
        const saved = recovery
          ? (
              await context.recoverOutput({
                ...output,
                recoveryAuthority: recoveryAuthority!,
                publication: { beforeWrite, previousAttempts: file.attempts }
              })
            ).artifact
          : await context.saveOutput(output)
        if (file.versionId && file.versionId !== saved.versionId)
          throw new Error('A retained output collection changed its recorded Artifact Version.')
        file.versionId = saved.versionId
        outputs.push({ filename: file.filename, versionId: saved.versionId })
        await this.writeJournal(journal)
      }
      await this.publishObservation(journal, context, outputs, recovery, observationHandle)
      const result: ManagedExecutionResult = {
        collectionId: journal.key,
        executionInvocationId: 'managed-' + journal.key,
        runId: frozen.runId,
        status: frozen.status,
        exitCode: frozen.exitCode,
        outputs,
        missingOptionalOutputs: frozen.missingOptionalOutputs,
        ...(frozen.missingCancelledOutputs?.length
          ? { missingCancelledOutputs: frozen.missingCancelledOutputs }
          : {}),
        ...(journal.observation ? { observation: journal.observation } : {}),
        ...(journal.projectRecording ? { projectRecording: journal.projectRecording } : {})
      }
      // This ordinary Artifact records the current collection event. Recovery never claims a new
      // producer Run and never reopens the prior Artifact turn. Earlier partial receipts remain.
      const receiptName = recovery
        ? `collection-${journal.key.slice(0, 16)}-${context.operationId}.json`
        : 'execution-' + frozen.runId + '.json'
      const receipt = await context.saveOutput({
        filename: receiptName,
        contentType: 'application/json',
        source: {
          kind: 'inline',
          content: JSON.stringify(
            {
              kind: 'managed-research-execution',
              version: 1,
              source: environment.source,
              materials: environment.prepared?.inputs,
              supplementalInputs: journal.supplementalInputs,
              runtime: publicRuntime(environment.runtime),
              environmentFingerprint: environment.fingerprint,
              purpose: journal.purpose,
              demoViewing: journal.demoViewing,
              executionProfile: journal.executionProfile,
              transport: collection.transport,
              collectedWithoutExecution: recovery,
              result
            },
            null,
            2
          )
        }
      })
      outputs.push({ filename: receiptName, versionId: receipt.versionId })
      journal.state = 'awaiting-publication'
      journal.result = resultSchema.parse(result)
      // Saving bytes precedes the ordinary turn's publication marker. Retain the environment until
      // every exact Version, including this receipt, is finalized and publicly visible.
      await this.writeJournal(journal)
      this.publicationCandidates.set(journal.key, journal)
      return journal.result
    } finally {
      if (recoveryAuthority) revokeManagedOutputRecoveryAuthority(recoveryAuthority)
    }
  }

  async execute(value: unknown): ReturnType<SessionOperationOwner['start']> {
    return this.startExecution(value, 'research')
  }

  inspectOfflinePlans(value: unknown, signal?: AbortSignal): Promise<OfflinePlanInspection> {
    return this.offlinePlans.inspect(value, signal)
  }

  /** External clients select a package plan; Main retains its offline policy and provenance. */
  async executeOfflinePlan(
    value: unknown
  ): Promise<Awaited<ReturnType<SessionOperationOwner['start']>> & { environmentId: string }> {
    const { request, options } = await this.offlinePlans.prepare(value)
    return { ...(await this.executeDemo(request, options)), environmentId: request.environmentId }
  }

  /** Borrow the current ordinary Session turn instead of starting a hidden/parallel Session. */
  async executeOfflinePlanInTurn(
    value: unknown,
    context: ManagedExecutionTurnContext,
    signal?: AbortSignal
  ): Promise<ManagedExecutionResult & { environmentId: string }> {
    const selected = executeOfflinePlanRequestSchema.parse(value)
    if (
      selected.projectId !== context.projectId ||
      selected.sessionId !== context.sessionId ||
      !context.provenanceContext.rootFrameId ||
      context.provenanceContext.rootFrameId !== context.provenanceContext.agentFrameId
    )
      throw new Error('Offline execution requires the current Main Agent Session context.')
    const { request, options } = await this.offlinePlans.prepare(
      selected,
      context.operationId,
      signal
    )
    return {
      ...(await this.executeDemoInTurn(request, context, signal, options)),
      environmentId: request.environmentId
    }
  }

  /** Main-only admitted offline execution. Public schemas cannot inject its policy. */
  async executeDemo(
    value: unknown,
    options: { inputVersionIds?: string[]; demoViewing?: RunObservationDemoViewingAdmission } = {}
  ): ReturnType<SessionOperationOwner['start']> {
    return this.startExecution(value, 'offline-demo', options.inputVersionIds, options.demoViewing)
  }

  private async startExecution(
    value: unknown,
    purpose: 'research' | 'offline-demo',
    inputVersionIds?: string[],
    demoViewing?: RunObservationDemoViewingAdmission
  ): ReturnType<SessionOperationOwner['start']> {
    const request = executeManagedEnvironmentRequestSchema.parse(value)
    demoViewing = this.validateDemoViewing(request, purpose, demoViewing)
    if (purpose === 'offline-demo' && request.profileId)
      throw new Error('Offline demos cannot use research profiles.')
    if (request.projectView && !this.dependencies.registerProjectService)
      throw new Error('Interactive project viewing is not available in this runtime.')
    if (request.recordObservation && !this.dependencies.observation)
      throw new Error('Run observation is not available in this runtime.')
    inputVersionIds =
      inputVersionIds === undefined ? undefined : z.array(identity).max(32).parse(inputVersionIds)
    const previousOperation = await this.dependencies.operations.get({
      projectId: request.projectId,
      sessionId: request.sessionId,
      requestId: request.requestId
    })
    const initialLease = previousOperation ? undefined : await this.acquireExecutionProfile(request)
    try {
      if (initialLease?.secretValues.some((secret) => JSON.stringify(request).includes(secret)))
        throw new Error('Research credentials must not appear in commands or execution requests.')
    } finally {
      initialLease?.release()
    }
    return this.dependencies.operations.start({
      projectId: request.projectId,
      sessionId: request.sessionId,
      requestId: request.requestId,
      requestFingerprint:
        purpose === 'research' &&
        !request.profileId &&
        !inputVersionIds?.length &&
        previousOperation?.requestFingerprint === digest(JSON.stringify(request))
          ? previousOperation.requestFingerprint
          : digest(
              JSON.stringify({
                request,
                purpose,
                ...(demoViewing ? { demoViewing } : {}),
                ...(inputVersionIds?.length ? { inputVersionIds } : {})
              })
            ),
      requestText: request.description ?? 'Run the selected prepared research materials.',
      execute: async (context, signal) => {
        let result: ManagedExecutionResult
        try {
          result =
            purpose === 'offline-demo'
              ? await this.executeDemoInTurn(request, context, signal, {
                  inputVersionIds,
                  demoViewing
                })
              : await this.executeInTurn(request, context, signal)
        } catch (error) {
          if (!(error instanceof ManagedEnvironmentCancelledError)) throw error
          return { status: 'cancelled', text: error.message }
        }
        return {
          status: result.status,
          text:
            'Prepared execution ' +
            result.status +
            '. Notebook Run: ' +
            result.runId +
            '. Saved outputs: ' +
            result.outputs.length +
            '.'
        }
      }
    })
  }

  getOperation(value: unknown): ReturnType<SessionOperationOwner['get']> {
    return this.dependencies.operations.get(managedOperationReferenceSchema.parse(value))
  }

  cancelOperation(value: unknown): ReturnType<SessionOperationOwner['cancel']> {
    return this.dependencies.operations.cancel(managedOperationReferenceSchema.parse(value))
  }

  async waitOperation(value: unknown): ReturnType<SessionOperationOwner['get']> {
    const request = managedOperationReferenceSchema
      .extend({
        timeoutMs: z.number().int().min(1).max(60_000).default(30_000)
      })
      .parse(value)
    const scope = {
      projectId: request.projectId,
      sessionId: request.sessionId,
      requestId: request.requestId
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.dependencies.operations.wait(scope),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, request.timeoutMs)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
    return this.dependencies.operations.get(scope)
  }

  async executeInTurn(
    value: unknown,
    admittedContext: ManagedExecutionTurnContext,
    signal?: AbortSignal
  ): Promise<ManagedExecutionResult> {
    return this.executeWithPurpose(value, admittedContext, signal, 'research')
  }

  async executeDemoInTurn(
    value: unknown,
    admittedContext: ManagedExecutionTurnContext,
    signal?: AbortSignal,
    options: { inputVersionIds?: string[]; demoViewing?: RunObservationDemoViewingAdmission } = {}
  ): Promise<ManagedExecutionResult> {
    return this.executeWithPurpose(
      value,
      admittedContext,
      signal,
      'offline-demo',
      options.inputVersionIds,
      options.demoViewing
    )
  }

  private validateDemoViewing(
    request: z.output<typeof executeManagedEnvironmentRequestSchema>,
    purpose: 'research' | 'offline-demo',
    value: RunObservationDemoViewingAdmission | undefined
  ): RunObservationDemoViewingAdmission | undefined {
    if (value === undefined) return undefined
    const admitted = runObservationDemoViewingAdmissionSchema.parse(value)
    if (
      purpose !== 'offline-demo' ||
      admitted.timeoutMs !== request.timeoutMs ||
      (admitted.mode === 'until-stop-or-timeout' && !request.projectView)
    )
      throw new Error('Demo viewing does not match the admitted offline execution.')
    return admitted
  }

  private async executeWithPurpose(
    value: unknown,
    admittedContext: ManagedExecutionTurnContext,
    signal: AbortSignal | undefined,
    purpose: 'research' | 'offline-demo',
    inputVersionIds?: string[],
    demoViewing?: RunObservationDemoViewingAdmission
  ): Promise<ManagedExecutionResult> {
    const request = executeManagedEnvironmentRequestSchema.parse(value)
    demoViewing = this.validateDemoViewing(request, purpose, demoViewing)
    if (request.projectView && !this.dependencies.registerProjectService)
      throw new Error('Interactive project viewing is not available in this runtime.')
    if (request.recordObservation && !this.dependencies.observation)
      throw new Error('Run observation is not available in this runtime.')
    const context: ManagedExecutionTurnContext = Object.freeze({
      operationId: admittedContext.operationId,
      executionInvocationId: admittedContext.executionInvocationId,
      projectId: admittedContext.projectId,
      sessionId: admittedContext.sessionId,
      workspaceCwd: admittedContext.workspaceCwd,
      provenanceContext: Object.freeze({ ...admittedContext.provenanceContext }),
      recordRun: admittedContext.recordRun.bind(admittedContext),
      saveOutput: admittedContext.saveOutput.bind(admittedContext),
      ...(admittedContext.saveAuxiliaryOutput
        ? { saveAuxiliaryOutput: admittedContext.saveAuxiliaryOutput.bind(admittedContext) }
        : {}),
      recoverOutput: admittedContext.recoverOutput.bind(admittedContext)
    })
    if (request.projectId !== context.projectId || request.sessionId !== context.sessionId) {
      throw new Error('Prepared execution does not belong to the admitted Session.')
    }
    if (
      !context.provenanceContext.rootFrameId ||
      context.provenanceContext.agentFrameId !== context.provenanceContext.rootFrameId
    )
      throw new Error('Prepared execution is currently available in the Main Agent context.')
    const key = digest(
      JSON.stringify([context.projectId, context.sessionId, context.operationId, request.requestId])
    )
    inputVersionIds =
      inputVersionIds === undefined ? undefined : z.array(identity).max(32).parse(inputVersionIds)
    if (purpose === 'offline-demo' && request.profileId)
      throw new Error('Offline demos cannot use research profiles.')
    const fingerprint = digest(
      JSON.stringify({
        request,
        purpose,
        ...(demoViewing ? { demoViewing } : {}),
        ...(inputVersionIds?.length ? { inputVersionIds } : {})
      })
    )
    const existing = this.active.get(key)
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new Error('Prepared execution request conflicts with its earlier contents.')
      return existing.completion
    }
    const completion = this.executeOnce(
      request,
      context,
      signal,
      key,
      fingerprint,
      purpose,
      inputVersionIds,
      demoViewing
    )
    this.active.set(key, { fingerprint, completion })
    try {
      return await completion
    } finally {
      if (this.active.get(key)?.completion === completion) this.active.delete(key)
    }
  }

  private async executeOnce(
    request: z.output<typeof executeManagedEnvironmentRequestSchema>,
    context: ManagedExecutionTurnContext,
    signal: AbortSignal | undefined,
    key: string,
    fingerprint: string,
    purpose: 'research' | 'offline-demo',
    inputVersionIds?: string[],
    demoViewing?: RunObservationDemoViewingAdmission
  ): Promise<ManagedExecutionResult> {
    const existing = await this.readJournal(key)
    if (existing) {
      if (
        existing.fingerprint !== fingerprint &&
        !(
          purpose === 'research' &&
          existing.purpose === undefined &&
          !request.profileId &&
          !inputVersionIds?.length &&
          existing.fingerprint === digest(JSON.stringify(request))
        )
      )
        throw new Error('Prepared execution request conflicts with its earlier contents.')
      if (existing.result) {
        await this.refreshObservation(existing)
        return existing.result
      }
      throw new Error(
        'Prepared execution was interrupted or failed. Query its environment and collect retained outputs without rerunning the command.'
      )
    }
    signal?.throwIfAborted()
    const supplementalInputs = await this.verifySupplementalInputs(
      request,
      inputVersionIds ?? [],
      signal
    )
    const credentialLease = await this.acquireExecutionProfile(request)
    if (credentialLease?.secretValues.some((secret) => JSON.stringify(request).includes(secret))) {
      credentialLease.release()
      throw new Error('Research credentials must not appear in commands or execution requests.')
    }
    const journal: Journal = {
      schemaVersion: 1,
      key,
      fingerprint,
      purpose,
      ...(purpose === 'offline-demo'
        ? {
            demoViewing:
              demoViewing ??
              runObservationDemoViewingAdmissionSchema.parse({
                mode: 'process-lifetime',
                timeoutMs: request.timeoutMs
              })
          }
        : {}),
      ...(supplementalInputs.length ? { supplementalInputs } : {}),
      ...(credentialLease
        ? {
            executionProfile: {
              profileId: credentialLease.profile.profileId,
              displayName: credentialLease.profile.displayName,
              variables: credentialLease.profile.variables,
              allowedNetworkHosts: credentialLease.profile.allowedNetworkHosts,
              conditionChanges: credentialLease.profile.conditionChanges,
              descriptorSha256: credentialLease.profile.binding.descriptorSha256,
              planKey: credentialLease.profile.binding.planKey
            },
            credentialOutputsChecked: false
          }
        : {}),
      projectId: request.projectId,
      sessionId: request.sessionId,
      operationId: context.operationId,
      requestId: request.requestId,
      ...(request.projectView ? { projectView: request.projectView } : {}),
      ...(request.recordObservation ? { recordObservation: true } : {}),
      state: 'running',
      collection: {
        environmentId: request.environmentId,
        provenance: provenanceSchema.parse(context.provenanceContext),
        selections: request.outputs,
        transport: request.localServicePort === undefined ? 'none' : 'private-unix-socket'
      }
    }
    try {
      await this.writeJournal(journal)
    } catch (error) {
      credentialLease?.release()
      throw error
    }
    const proof = request.projectView
      ? {
          value: randomBytes(32).toString('hex'),
          path: '/__open_science_proof_' + randomBytes(16).toString('hex')
        }
      : undefined
    const generationId = randomUUID()
    const output = {
      stdout: '',
      stderr: '',
      truncated: false,
      secrets: [
        ...(proof ? [proof.value, proof.path] : []),
        ...(credentialLease?.secretValues ?? [])
      ]
    } as {
      runId?: string
      stdout: string
      stderr: string
      truncated: boolean
      secrets: string[]
    }
    this.liveOutput.set(key, output)
    const observeOutput = (chunk: ManagedShellOutput): void => {
      if (this.liveOutput.get(key) !== output || (output.runId && output.runId !== chunk.runId))
        return
      output.runId = chunk.runId
      const text = output[chunk.stream] + chunk.text
      const limit = 64 * 1024
      if (text.length <= limit) output[chunk.stream] = text
      else {
        const tail = text.slice(-limit)
        const newline = tail.indexOf('\n')
        output[chunk.stream] = newline < 0 ? '' : tail.slice(newline + 1)
        output.truncated = true
      }
    }
    let unregisterService: (() => void) | undefined
    let observationHandle: RunObservationRecordingHandle | undefined
    let mediaEnvironment: ManagedEnvironmentExecutionContext | undefined
    let mediaLease: { close(): Promise<void> } | undefined
    const closeMedia = async (): Promise<void> => {
      const lease = mediaLease
      mediaLease = undefined
      // Capture is auxiliary; drain its tracked writes without replacing the Run outcome.
      await lease?.close().catch(() => undefined)
    }
    try {
      return await this.dependencies.withWritableSession(request, async () => {
        if (request.recordObservation) {
          try {
            const capture = await this.observation.begin(observationTarget(journal), context)
            observationHandle = capture.handle
            journal.observation = capture.result
          } catch {
            // Capture admission is auxiliary. Publication and drain still run through the
            // adapter so an interrupted capture cannot bypass its exact write authority.
            journal.observation = { status: 'failed', warning: 'capture-start-failed' }
          }
          await this.writeJournal(journal).catch(() => undefined)
        }
        return this.dependencies.environments.withExecution(
          {
            ...request,
            confinement: {
              mode: purpose,
              allowedNetworkHosts: credentialLease?.profile.allowedNetworkHosts ?? []
            },
            ...(credentialLease
              ? {
                  privateEnvironment: credentialLease.privateEnvironment,
                  secretValues: credentialLease.secretValues
                }
              : {}),
            executionInvocationId: 'managed-' + key,
            collectionId: key,
            retainCollection: true,
            onOutput: observeOutput,
            ...(proof
              ? {
                  serviceProof: proof,
                  onServiceAllocated: (allocated: {
                    runId: string
                    socketPath: string
                    signal: AbortSignal
                  }): void => {
                    unregisterService = this.dependencies.registerProjectService!({
                      scope: {
                        projectId: request.projectId,
                        sessionId: request.sessionId,
                        environmentId: request.environmentId,
                        runId: allocated.runId,
                        generationId
                      },
                      declaration: request.projectView!,
                      socketPath: allocated.socketPath,
                      logicalPort: request.localServicePort!,
                      proof,
                      signal: allocated.signal
                    })
                    if (
                      observationHandle &&
                      mediaEnvironment &&
                      context.saveAuxiliaryOutput &&
                      this.dependencies.registerObservationMedia
                    ) {
                      try {
                        mediaLease = this.dependencies.registerObservationMedia({
                          target: {
                            projectId: request.projectId,
                            sessionId: request.sessionId,
                            operationId: context.operationId,
                            executionInvocationId: 'managed-' + key,
                            runId: allocated.runId
                          },
                          generationId,
                          recording: observationHandle,
                          outputs: structuredClone(request.outputs),
                          outputAuthority: mediaEnvironment.createOutputAuthority(
                            context.operationId
                          ),
                          saveAuxiliaryOutput: context.saveAuxiliaryOutput.bind(context),
                          signal: allocated.signal
                        })
                      } catch {
                        // The page and execution remain available when optional capture cannot start.
                      }
                    }
                  }
                }
              : {}),
            signal
          },
          async (environment) => {
            mediaEnvironment = environment
            const inputs = await this.dependencies.resolvePreparedInputs(environment.receipt)
            if (supplementalInputs.length && environment.receipt.prepared)
              inputs.push(
                ...(await this.dependencies.resolvePreparedInputs({
                  ...environment.receipt,
                  prepared: { ...environment.receipt.prepared, inputs: supplementalInputs }
                }))
              )
            const executionInvocationId = 'managed-' + key
            let projectRecording: ReturnType<
              NonNullable<ManagedExecutionServiceDependencies['registerProjectRecording']>
            >
            let browserRecording:
              | ReturnType<
                  NonNullable<ManagedExecutionServiceDependencies['registerBrowserRecording']>
                >
              | undefined
            if (
              request.projectView &&
              context.saveAuxiliaryOutput &&
              this.dependencies.registerBrowserRecording
            ) {
              try {
                browserRecording = this.dependencies.registerBrowserRecording({
                  target: {
                    projectId: request.projectId,
                    sessionId: request.sessionId,
                    operationId: context.operationId,
                    executionInvocationId
                  },
                  outputs: structuredClone(request.outputs),
                  outputAuthority: environment.createOutputAuthority(context.operationId),
                  saveAuxiliaryOutput: screenAuxiliaryOutput(
                    context.saveAuxiliaryOutput.bind(context),
                    credentialLease?.secretValues ?? []
                  ),
                  signal: environment.publicationSignal
                })
              } catch {
                // Optional recording admission never prevents the original experiment.
              }
            }
            if (
              request.recordObservation &&
              context.saveAuxiliaryOutput &&
              this.dependencies.registerProjectRecording
            ) {
              try {
                projectRecording = this.dependencies.registerProjectRecording({
                  target: {
                    projectId: request.projectId,
                    sessionId: request.sessionId,
                    operationId: context.operationId,
                    executionInvocationId
                  },
                  outputs: structuredClone(request.outputs),
                  outputAuthority: environment.createOutputAuthority(context.operationId),
                  saveAuxiliaryOutput: screenAuxiliaryOutput(
                    context.saveAuxiliaryOutput.bind(context),
                    credentialLease?.secretValues ?? []
                  ),
                  signal: environment.publicationSignal
                })
              } catch {
                journal.projectRecording = { status: 'unavailable', warnings: ['capture-failed'] }
              }
            }
            let processFinished = false
            try {
              await this.dependencies.runtime.executeManagedShell(
                {
                  projectId: request.projectId,
                  sessionId: request.sessionId,
                  workspaceCwd: context.workspaceCwd,
                  command: request.command,
                  timeoutMs: request.timeoutMs,
                  executionInvocationId,
                  rootExecutionId: context.operationId,
                  provenanceContext: context.provenanceContext,
                  registeredInputFiles: inputs
                },
                environment.capability,
                environment.signal,
                context.executionInvocationId
                  ? { parentControlInvocationId: context.executionInvocationId }
                  : undefined
              )
              processFinished = true
            } finally {
              // Finish inside the environment/turn authority lifetime, including cancellation.
              // Capture failure never changes the experiment outcome or retries execution.
              await browserRecording
                ?.close(
                  environment.signal.aborted
                    ? 'stopped'
                    : processFinished
                      ? 'finished'
                      : 'interrupted'
                )
                .catch(() => undefined)
              if (projectRecording) {
                try {
                  journal.projectRecording = projectRecordingResultSchema.parse(
                    await projectRecording.close(
                      environment.signal.aborted
                        ? 'stopped'
                        : processFinished
                          ? 'finished'
                          : 'interrupted'
                    )
                  )
                } catch {
                  journal.projectRecording = {
                    status: 'unavailable',
                    warnings: ['publication-failed']
                  }
                }
              }
              if (journal.projectRecording) await this.writeJournal(journal).catch(() => undefined)
            }
            await closeMedia()
            const cleanup = await this.dependencies.runtime.confirmManagedShellCleanup(
              { projectId: request.projectId, sessionId: request.sessionId, executionInvocationId },
              { retry: true }
            )
            if (
              !cleanup.reaped ||
              !cleanup.runId ||
              cleanup.scope.projectId !== request.projectId ||
              cleanup.scope.sessionId !== request.sessionId ||
              cleanup.scope.executionInvocationId !== executionInvocationId
            )
              throw new Error('Prepared execution has no verified stopped Notebook Run.')
            unregisterService?.()
            unregisterService = undefined
            await context.recordRun(cleanup.runId)
            const authority = environment.createOutputAuthority(context.operationId)
            await this.freezeCollection(journal, context, authority, environment.publicationSignal)
            await this.checkCredentialOutputs(
              journal,
              context,
              authority,
              credentialLease?.secretValues ?? [],
              environment.publicationSignal
            )
            if (journal.collection!.frozen!.runId !== cleanup.runId)
              throw new Error('Collected output producer differs from the verified stopped Run.')
            return this.publishCollection(
              journal,
              context,
              environment.receipt,
              authority,
              environment.publicationSignal,
              false,
              observationHandle
            )
          }
        )
      })
    } catch (error) {
      // A durable completed result is not undone by a later resource-cleanup failure. Its pending
      // retention can be cleared through collectOutputs once the original stop is verified.
      if (!journal.result) {
        journal.state = 'failed'
        await this.writeJournal(journal)
      }
      throw error
    } finally {
      credentialLease?.release()
      // Keep cleanup order independent of optional observation. Finish drains its own pending
      // reads and freezes a truthful partial on errors; it never cancels or restarts the Run.
      await closeMedia()
      if (observationHandle) await this.observation.drain(observationHandle)
      unregisterService?.()
      this.liveOutput.delete(key)
    }
  }
}
