import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../shared/session-persistence'
import {
  DEFAULT_PERMISSION_PROFILE,
  type PermissionProfileId
} from '../../shared/permission-profiles'
import {
  releaseResolvedAgentBackendLeases,
  type AgentModelConfig,
  type AgentSpawnInput,
  type ResolvedAgentBackend,
  type SessionSetup
} from '../agent-framework'
import { isolateCodeBuddyEnvironment } from '../agent-framework/codebuddy'
import { createAcpRuntime, type AcpRuntimeCompositionOptions } from '../acp/runtime-composition'
import type { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import type { NotebookRpcConnection } from '../notebook/mcp-server'
import type { SessionKey } from './session-records'
import type { AcpDelegateExecutionCallbacks, PreparedDelegateExecution } from './acp-execution'
import type { DelegateExecutionInput } from './execution-port'
import {
  createProductionDelegatedFrameworks,
  type PreparedProductionFrameworkScope,
  type ProductionDelegatedFrameworks
} from './production-frameworks'

type ProductionFrameworkRuntimeOptions = Readonly<{
  capacity: number
  dataRoot: string
  runtime: Omit<
    AcpRuntimeCompositionOptions,
    | 'notebookRpcServer'
    | 'fixedBackend'
    | 'runtimeCallbacks'
    | 'delegatedNotebookConnection'
    | 'delegatedArtifactCurrentRunFile'
    | 'spawnAgent'
    | 'delegatedWork'
  >
  notebookRpcServer(): NotebookLocalRpcServer
  readSession(key: SessionKey): Promise<PersistedChatSession | undefined>
  resolvePermissionProfile?(sessionId: string): PermissionProfileId | undefined
}>

const DELEGATED_CHILD_SYSTEM_PROMPT_APPEND = [
  'You are a Subagent executing a delegated Attempt for the Main Agent.',
  'Your final response is automatically preserved as the canonical terminal result for this Attempt, including ordinary conclusions, change summaries, validation results, Artifacts, and any required structured output.',
  "Use host.sendFrameMessage('parent', ...) only while the Attempt is still running when the Main Agent needs an early actionable update, must answer a question, or must coordinate around a blocker or material risk.",
  'When a structured-output schema is configured, submitting it with host.submitOutput(value) remains mandatory; that submission supplements and never replaces your ordinary final response.',
  'Do not duplicate your final response through parent messaging when completing normally.'
].join(' ')

const withDelegatedChildContext = (backend: ResolvedAgentBackend): ResolvedAgentBackend => ({
  ...backend,
  systemPromptAppends: [
    ...(backend.systemPromptAppends ?? []),
    DELEGATED_CHILD_SYSTEM_PROMPT_APPEND
  ]
})

const openCodeModelConfig = (backend: ResolvedAgentBackend): AgentModelConfig => ({
  env: { ...backend.env },
  configFiles: [
    {
      path: 'opencode.json',
      content: backend.env.OPENCODE_CONFIG_CONTENT ?? '{}'
    }
  ]
})

const sessionSetup = (backend: ResolvedAgentBackend): SessionSetup =>
  backend.framework.buildSessionSetup({
    systemPromptAppends: [
      ...(backend.systemPromptAppends ?? []),
      ...(backend.persistentSystemPrompt ? [backend.persistentSystemPrompt] : [])
    ],
    ...(backend.sessionOptions ? { sessionOptions: backend.sessionOptions } : {})
  })

const prepareCodeBuddyDelegateSpawn = async (
  backend: ResolvedAgentBackend,
  runtimeHome: string
): Promise<AgentSpawnInput> => ({
  executablePath: backend.executablePath,
  args: [...(backend.args ?? [])],
  env: await isolateCodeBuddyEnvironment(backend.env, join(runtimeHome, 'codebuddy')),
  proxyEnvironmentMode: backend.proxyEnvironmentMode
})

const createProductionDelegatedFrameworkRuntime = (
  options: ProductionFrameworkRuntimeOptions
): ProductionDelegatedFrameworks =>
  createProductionDelegatedFrameworks({
    capacity: options.capacity,
    async certify(session) {
      const frameworkId = session.agentFrameworkId
      if (!frameworkId) throw new Error('Delegated Work Session has no framework identity.')
      const preparedAttempts = new Map<
        string,
        Readonly<{
          backend: ResolvedAgentBackend
          connection: NotebookRpcConnection
          releaseBackend: boolean
        }>
      >()
      // The exact provider/model is validated by admission's model resolver. This certification hook
      // must not read the process-wide Active model, which may differ from the originating Session.
      const assertProviderAvailable = async (): Promise<void> => undefined
      const prepare = async (
        input: DelegateExecutionInput
      ): Promise<PreparedProductionFrameworkScope> => {
        if (!input.workspaceCwd) throw new Error('Delegated Attempt has no prepared Frame cwd.')
        if (!input.executionModel) {
          throw new Error('Delegated Attempt has no admitted model snapshot.')
        }
        const resolveAdmitted = options.runtime.settingsService.resolveAdmittedSubagentBackend
        if (!input.executionBackend && !resolveAdmitted) {
          throw new Error('Admitted delegated backend resolution is unavailable.')
        }
        const releaseResolvedBackend = input.executionBackend === undefined
        const backend =
          input.executionBackend ??
          (await resolveAdmitted!.call(options.runtime.settingsService, input.executionModel))
        if (backend.framework.id !== frameworkId) {
          if (releaseResolvedBackend) await releaseResolvedAgentBackendLeases(backend)
          throw new Error('Resolved delegated backend changed framework during admission.')
        }
        const runtimeHome = join(
          options.dataRoot,
          'delegation',
          input.session.projectId,
          input.session.sessionId,
          'runtime',
          input.attemptId
        )
        try {
          await mkdir(runtimeHome, { recursive: true, mode: 0o700 })
          const durable = await options.readSession(input.session)
          const graph = durable && materializeSessionConversationGraph(durable).conversationGraph
          const frame = graph?.frames.find((candidate) => candidate.id === input.frameId)
          const branch = graph?.branches.find((candidate) => candidate.id === frame?.activeBranchId)
          const prompt = graph?.messages.find(
            (candidate) => candidate.id === branch?.headMessageId && candidate.role === 'user'
          )
          if (!durable || !graph || !frame || !branch || !prompt) {
            throw new Error('Delegated Attempt has no durable Frame provenance.')
          }
          const capability = await options.notebookRpcServer().issueDelegatedNotebookConnection({
            projectId: input.session.projectId,
            sessionId: input.session.sessionId,
            rootFrameId: graph.rootFrameId,
            agentFrameId: input.frameId,
            attemptId: input.attemptId,
            messageBranchId: branch.id,
            runtimeSegmentId: input.runtimeSegmentId,
            promptMessageId: prompt.id,
            workspaceCwd: input.workspaceCwd,
            isAttemptWritable: async () => {
              const latest = await options.readSession(input.session)
              const attempt = latest?.runtimeContext?.delegatedWork?.records
                .find((record) => record.agentFrameId === input.frameId)
                ?.attempts.at(-1)
              return attempt?.id === input.attemptId && attempt.status === 'running'
            }
          })
          preparedAttempts.set(input.attemptId, {
            backend,
            connection: capability,
            releaseBackend: releaseResolvedBackend
          })
          const base: PreparedDelegateExecution = {
            executionId: input.attemptId,
            provenance: {
              projectId: input.session.projectId,
              sessionId: input.session.sessionId,
              agentFrameId: input.frameId,
              runtimeSegmentId: input.runtimeSegmentId,
              promptMessageId: prompt.id,
              messageBranchId: branch.id
            },
            workspace: { cwd: input.workspaceCwd },
            runtimeHome,
            frameworkId,
            permissionProfile:
              options.resolvePermissionProfile?.(input.session.sessionId) ??
              durable.permissionProfile ??
              DEFAULT_PERMISSION_PROFILE,
            capability,
            ...(input.artifactCurrentRunFile
              ? { artifactCurrentRunFile: input.artifactCurrentRunFile }
              : {}),
            async disposeResources() {
              const owned = preparedAttempts.get(input.attemptId)
              preparedAttempts.delete(input.attemptId)
              if (owned?.releaseBackend) await releaseResolvedAgentBackendLeases(owned.backend)
              await rm(runtimeHome, { recursive: true, force: true }).catch(() => undefined)
            }
          }
          if (frameworkId === 'claude-code') {
            return { ...base, sessionSetup: sessionSetup(backend) }
          }
          if (frameworkId === 'opencode') {
            return { ...base, modelConfig: openCodeModelConfig(backend) }
          }
          if (frameworkId === 'codex') {
            return {
              ...base,
              spawn: {
                executablePath: backend.executablePath,
                args: [...(backend.args ?? [])],
                env: {
                  ...backend.env,
                  HOME: runtimeHome,
                  CODEX_HOME: runtimeHome
                },
                proxyEnvironmentMode: backend.proxyEnvironmentMode
              }
            }
          }
          if (frameworkId === 'codebuddy') {
            return {
              ...base,
              spawn: await prepareCodeBuddyDelegateSpawn(backend, runtimeHome)
            }
          }
          const unsupported: never = frameworkId
          throw new Error(`Unsupported delegated-work framework: ${String(unsupported)}`)
        } catch (error) {
          preparedAttempts.delete(input.attemptId)
          if (releaseResolvedBackend) await releaseResolvedAgentBackendLeases(backend)
          await rm(runtimeHome, { recursive: true, force: true }).catch(() => undefined)
          throw error
        }
      }
      const createRuntime = (
        scope: PreparedProductionFrameworkScope,
        callbacks: AcpDelegateExecutionCallbacks,
        agentProcess?: ChildProcessWithoutNullStreams
      ): ReturnType<typeof createAcpRuntime> => {
        const owned = preparedAttempts.get(scope.executionId)
        if (!owned) throw new Error('Delegated runtime scope is unavailable.')
        preparedAttempts.delete(scope.executionId)
        try {
          return createAcpRuntime({
            ...options.runtime,
            notebookRpcServer: options.notebookRpcServer(),
            fixedBackend: withDelegatedChildContext(owned.backend),
            runtimeCallbacks: callbacks,
            delegatedNotebookConnection: owned.connection,
            permissionGrantContext: {
              projectId: scope.provenance.projectId,
              sessionId: scope.provenance.sessionId
            },
            ...(scope.artifactCurrentRunFile
              ? { delegatedArtifactCurrentRunFile: scope.artifactCurrentRunFile }
              : {}),
            ...(agentProcess ? { spawnAgent: () => agentProcess } : {})
          })
        } catch (error) {
          if (owned.releaseBackend) void releaseResolvedAgentBackendLeases(owned.backend)
          throw error
        }
      }

      return {
        frameworkId,
        assertProviderAvailable,
        prepare,
        createRuntime
      }
    }
  })

export {
  createProductionDelegatedFrameworkRuntime,
  DELEGATED_CHILD_SYSTEM_PROMPT_APPEND,
  prepareCodeBuddyDelegateSpawn,
  withDelegatedChildContext
}
export type { ProductionFrameworkRuntimeOptions }
