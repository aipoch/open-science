import type { PromptResponse } from '@agentclientprotocol/sdk'
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { isCodexSubscriptionProviderId } from '../../shared/settings'
import type { AcpMessageImage, AcpRuntimeEvent, AcpTurnTokenUsage } from '../../shared/acp'
import type { AgentFrameworkId } from '../../shared/settings'
import type { ResolvedAgentBackend } from '../agent-framework'
import type { ExplicitAgentBackendTarget } from '../settings/backend-resolver'
import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'
import { composeAcpRuntimeSessionOwners } from './runtime-session-composition'
import { AcpRuntime, type AcpRuntimeOptions } from './runtime'
import { prepareRestrictedBackend } from './restricted-runtime-profile'

const STALE_PROFILE_AGE_MS = 24 * 60 * 60 * 1000
const DEFAULT_OUTPUT_LIMIT_BYTES = 256 * 1024
const PROVIDER_DEFAULT_MODEL = 'provider-default'

type RestrictedInferenceErrorCode =
  'cancelled' | 'output-limit' | 'shutting-down' | 'tool-violation' | 'transport-unavailable'

class RestrictedInferenceError extends Error {
  constructor(
    readonly code: RestrictedInferenceErrorCode,
    message: string
  ) {
    super(message)
  }
}

type RestrictedInferenceResult = Readonly<{
  text: string
  frameworkId: AgentFrameworkId
  model: string
  stopReason: PromptResponse['stopReason']
  usage?: AcpTurnTokenUsage
}>

type RestrictedInferenceRunInput = Readonly<{
  prompt: string
  images?: readonly AcpMessageImage[]
  target: ExplicitAgentBackendTarget
  systemPrompt: string
  agentName: string
  description: string
  signal?: AbortSignal
  outputLimitBytes?: number
}>

type RestrictedInferenceRuntime = Pick<
  AcpRuntime,
  'cancelPrompt' | 'createSession' | 'respondToPermission' | 'sendPrompt' | 'shutdownForQuit'
>

type RestrictedInferenceRunnerOptions = Readonly<{
  appVersion: string
  configRoot: string
  profileNamespace: string
  resolveTarget: (
    target: ExplicitAgentBackendTarget,
    context: {
      systemPromptAppends: string[]
      includeSkillAndConnectorContext: false
      forceCodexNativeResponsesCompatibility: true
    }
  ) => Promise<ResolvedAgentBackend>
  now?: () => number
  createRuntime?: (options: AcpRuntimeOptions) => RestrictedInferenceRuntime
  allowNativeCodexSubscription?: boolean
}>

type ActiveRun = {
  controller: AbortController
  done: Promise<void>
  finish: () => void
}

const deferred = (): Pick<ActiveRun, 'done' | 'finish'> => {
  let finish = (): void => undefined
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  return { done, finish }
}

const releaseUnattachedBackend = async (backend: ResolvedAgentBackend): Promise<void> => {
  const owned: Array<{ release: () => Promise<void> }> = []
  if (backend.responsesBridgeLease) owned.push(backend.responsesBridgeLease)
  if (backend.anthropicBridgeLease) owned.push(backend.anthropicBridgeLease)
  if (backend.providerTransportLease) owned.push(backend.providerTransportLease)
  await Promise.all([...new Set(owned)].map((lease) => lease.release().catch(() => undefined)))
}

const resolveRestrictedInferenceModel = (
  backend: Pick<ResolvedAgentBackend, 'contextUsageModel' | 'sessionModel'>,
  target: ExplicitAgentBackendTarget
): string =>
  backend.contextUsageModel?.trim() ||
  backend.sessionModel?.trim() ||
  (target.model.kind === 'required' ? target.model.id : PROVIDER_DEFAULT_MODEL)

const createRuntime = (options: AcpRuntimeOptions): RestrictedInferenceRuntime => {
  const base = composeAcpRuntimeBaseOwners(options)
  return new AcpRuntime(options, base, composeAcpRuntimeSessionOwners(options, base))
}

class RestrictedInferenceRunner {
  private readonly root: string
  private readonly now: () => number
  private readonly runtimeFactory: NonNullable<RestrictedInferenceRunnerOptions['createRuntime']>
  private readonly activeRuns = new Set<ActiveRun>()
  private shuttingDown = false

  constructor(private readonly options: RestrictedInferenceRunnerOptions) {
    this.root = join(options.configRoot, 'runtime-support', options.profileNamespace)
    this.now = options.now ?? Date.now
    this.runtimeFactory = options.createRuntime ?? createRuntime
  }

  supportsTarget(target: ExplicitAgentBackendTarget): boolean {
    return !(
      target.frameworkId === 'codex' &&
      isCodexSubscriptionProviderId(target.providerId) &&
      this.options.allowNativeCodexSubscription !== true
    )
  }

  async sweepStaleProfiles(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const entries = await readdir(this.root, { withFileTypes: true })
    await Promise.all(
      entries.flatMap((entry) => {
        if (!entry.isDirectory() || !entry.name.startsWith('job-')) return []
        const path = join(this.root, entry.name)
        return [
          stat(path)
            .then((value) =>
              this.now() - value.mtimeMs >= STALE_PROFILE_AGE_MS
                ? rm(path, { recursive: true, force: true })
                : undefined
            )
            .catch(() => undefined)
        ]
      })
    )
  }

  async run(input: RestrictedInferenceRunInput): Promise<RestrictedInferenceResult> {
    if (this.shuttingDown) {
      throw new RestrictedInferenceError('shutting-down', 'Restricted inference is shutting down.')
    }
    if (!this.supportsTarget(input.target)) {
      throw new RestrictedInferenceError(
        'transport-unavailable',
        'The selected Codex transport cannot enforce a tool-less session.'
      )
    }

    const lifecycle = deferred()
    const active: ActiveRun = {
      controller: new AbortController(),
      ...lifecycle
    }
    this.activeRuns.add(active)
    const forwardAbort = (): void => active.controller.abort(input.signal?.reason)
    input.signal?.addEventListener('abort', forwardAbort, { once: true })
    if (input.signal?.aborted) forwardAbort()

    let jobRoot: string | undefined
    let backend: ResolvedAgentBackend | undefined
    let backendTransferred = false
    let runtime: RestrictedInferenceRuntime | undefined
    let sessionId: string | undefined
    let toolLessBridgeScopeRegistered = false
    let toolViolation = false
    let outputLimitExceeded = false
    let assistantBytes = 0
    let turnUsage: AcpTurnTokenUsage | undefined
    const assistantChunks: string[] = []
    const outputLimitBytes = input.outputLimitBytes
    const cancelPrompt = (): void => {
      if (runtime && sessionId) void runtime.cancelPrompt({ sessionId }).catch(() => undefined)
    }
    const onAbort = (): void => cancelPrompt()
    active.controller.signal.addEventListener('abort', onAbort, { once: true })
    const ensureActive = (): void => {
      if (active.controller.signal.aborted) {
        throw new RestrictedInferenceError('cancelled', 'Restricted inference was cancelled.')
      }
    }

    const onEvent = (event: AcpRuntimeEvent): void => {
      if (event.kind === 'message' && event.role === 'assistant' && event.text) {
        assistantBytes += Buffer.byteLength(event.text, 'utf8')
        if (outputLimitBytes !== undefined && assistantBytes > outputLimitBytes) {
          outputLimitExceeded = true
          cancelPrompt()
        } else {
          assistantChunks.push(event.text)
        }
      }
      if (event.kind === 'stop' && event.turnUsage) turnUsage = event.turnUsage
      if (event.kind === 'tool') {
        toolViolation = true
        cancelPrompt()
      }
    }

    try {
      ensureActive()
      await mkdir(this.root, { recursive: true })
      jobRoot = await mkdtemp(join(this.root, 'job-'))
      const cwd = join(jobRoot, 'cwd')
      const profileRoot = join(jobRoot, 'profile')
      await Promise.all([mkdir(cwd), mkdir(profileRoot)])
      backend = await this.options.resolveTarget(input.target, {
        systemPromptAppends: [input.systemPrompt],
        includeSkillAndConnectorContext: false,
        forceCodexNativeResponsesCompatibility: true
      })
      ensureActive()
      const resolvedBackend = await prepareRestrictedBackend(backend, profileRoot, {
        agentName: input.agentName,
        description: input.description,
        systemPrompt: input.systemPrompt,
        openCodePermissions: { '*': 'deny' },
        steps: 1
      })
      backend = resolvedBackend
      ensureActive()
      const bridge = resolvedBackend.responsesBridgeLease
      const nativeCodexSubscriptionToolingDisabled =
        resolvedBackend.framework.id === 'codex' &&
        isCodexSubscriptionProviderId(input.target.providerId) &&
        this.options.allowNativeCodexSubscription === true
      if (
        resolvedBackend.framework.id === 'codex' &&
        !nativeCodexSubscriptionToolingDisabled &&
        (!bridge?.registerToolLessSession || !bridge.unregisterToolLessSession)
      ) {
        throw new RestrictedInferenceError(
          'transport-unavailable',
          'The selected Codex transport cannot enforce a tool-less session.'
        )
      }

      const runtimeOptions: AcpRuntimeOptions = {
        appVersion: this.options.appVersion,
        defaultCwd: cwd,
        resolveBackend: () => {
          backendTransferred = true
          return Promise.resolve(resolvedBackend)
        },
        callbacks: {
          onEvent,
          onPermissionRequest: (request) => {
            toolViolation = true
            void runtime
              ?.respondToPermission({ requestId: request.requestId, cancelled: true })
              .catch(() => undefined)
            cancelPrompt()
          }
        }
      }
      runtime = this.runtimeFactory(runtimeOptions)
      ensureActive()
      const created = await runtime.createSession({ cwd, permissionProfile: 'ask' })
      sessionId = created.sessionId
      ensureActive()
      if (bridge) {
        bridge.registerToolLessSession!(sessionId)
        toolLessBridgeScopeRegistered = true
      }
      ensureActive()
      const response = await runtime.sendPrompt({
        sessionId,
        text: input.prompt,
        ...(input.images?.length ? { historyImages: [...input.images] } : {}),
        suppressUserMessage: true
      })

      if (toolViolation) {
        throw new RestrictedInferenceError(
          'tool-violation',
          'The selected agent attempted to use a tool during restricted inference.'
        )
      }
      if (outputLimitExceeded) {
        throw new RestrictedInferenceError(
          'output-limit',
          `Restricted inference exceeded the ${outputLimitBytes}-byte output limit.`
        )
      }
      ensureActive()
      if (toolLessBridgeScopeRegistered) {
        const observed = bridge!.unregisterToolLessSession!(sessionId)
        toolLessBridgeScopeRegistered = false
        if (!observed) {
          throw new RestrictedInferenceError(
            'transport-unavailable',
            'The selected Codex transport did not apply its tool-less session scope.'
          )
        }
      }

      return Object.freeze({
        text: assistantChunks.join(''),
        frameworkId: resolvedBackend.framework.id,
        model: resolveRestrictedInferenceModel(resolvedBackend, input.target),
        stopReason: response.stopReason,
        ...(turnUsage ? { usage: Object.freeze({ ...turnUsage }) } : {})
      })
    } finally {
      input.signal?.removeEventListener('abort', forwardAbort)
      active.controller.signal.removeEventListener('abort', onAbort)
      if (sessionId && toolLessBridgeScopeRegistered) {
        backend?.responsesBridgeLease?.unregisterToolLessSession?.(sessionId)
      }
      await runtime?.shutdownForQuit().catch(() => undefined)
      if (backend && !backendTransferred) await releaseUnattachedBackend(backend)
      if (jobRoot) await rm(jobRoot, { recursive: true, force: true }).catch(() => undefined)
      this.activeRuns.delete(active)
      active.finish()
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    const active = [...this.activeRuns]
    for (const run of active) run.controller.abort()
    await Promise.all(active.map((run) => run.done))
  }
}

export {
  DEFAULT_OUTPUT_LIMIT_BYTES,
  RestrictedInferenceError,
  RestrictedInferenceRunner,
  resolveRestrictedInferenceModel
}
export type {
  RestrictedInferenceResult,
  RestrictedInferenceRunInput,
  RestrictedInferenceRunnerOptions,
  RestrictedInferenceRuntime
}
