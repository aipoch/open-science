import { resolveEffectiveSpecialistSkills } from '../../shared/specialist'
import { OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION } from '../skills/runtime-mcp-server'
import { DelegatedProcessOwnership } from './process-ownership'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmod, lstat, mkdir, readdir, rm } from 'node:fs/promises'
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
  type ResolvedAgentBackend,
  type SessionSetup
} from '../agent-framework'
import { createAcpRuntime, type AcpRuntimeCompositionOptions } from '../acp/runtime-composition'
import type { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import type { NotebookRpcConnection } from '../notebook/mcp-server'
import type { SessionKey } from './session-records'
import type { AcpDelegateExecutionCallbacks, PreparedDelegateExecution } from './acp-execution'
import type { DelegateExecutionInput } from './execution-port'
import {
  prepareOpenCodeRuntime,
  type PreparedOpenCodeRuntime
} from './opencode-runtime-preparation'
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
    | 'preparedSkills'
  >
  notebookRpcServer(): NotebookLocalRpcServer
  readSession(key: SessionKey): Promise<PersistedChatSession | undefined>
  resolvePermissionProfile?(sessionId: string): PermissionProfileId | undefined
  resolvePermissionPrompts?(sessionId: string): 'none' | undefined
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

const sessionSetup = (backend: ResolvedAgentBackend): SessionSetup =>
  backend.framework.buildSessionSetup({
    systemPromptAppends: [
      ...(backend.systemPromptAppends ?? []),
      ...(backend.persistentSystemPrompt ? [backend.persistentSystemPrompt] : [])
    ],
    ...(backend.sessionOptions ? { sessionOptions: backend.sessionOptions } : {})
  })

// Called before a child is spawned or after its process tree is confirmed reaped.
// Skip remaining symlinks so cleanup does not chmod their external targets.
const makeRuntimeCopyRemovable = async (path: string): Promise<void> => {
  const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (!entry || entry.isSymbolicLink()) return
  if (entry.isDirectory()) {
    await chmod(path, (entry.mode & 0o777) | 0o700)
    for (const child of await readdir(path, { withFileTypes: true })) {
      if (child.isDirectory() || (process.platform === 'win32' && child.isFile())) {
        await makeRuntimeCopyRemovable(join(path, child.name))
      }
    }
  } else if (process.platform === 'win32' && entry.isFile()) {
    // Windows also checks the readonly file attribute when deleting a file.
    await chmod(path, (entry.mode & 0o777) | 0o600)
  }
}

const createProductionDelegatedFrameworkRuntime = (
  options: ProductionFrameworkRuntimeOptions
): ProductionDelegatedFrameworks => {
  let standaloneOwnership: DelegatedProcessOwnership | undefined
  return createProductionDelegatedFrameworks({
    capacity: options.capacity,
    async certify(session, suppliedOwnership) {
      const ownership =
        suppliedOwnership ??
        (standaloneOwnership ??= new DelegatedProcessOwnership(options.dataRoot))
      const frameworkId = session.agentFrameworkId
      if (!frameworkId) throw new Error('Delegated Work Session has no framework identity.')
      const preparedAttempts = new Map<
        string,
        Readonly<{
          backend: ResolvedAgentBackend
          connection: NotebookRpcConnection
          preparedSkills?: AcpRuntimeCompositionOptions['preparedSkills']
        }>
      >()
      // The exact provider/model is validated by admission's model resolver. This certification hook
      // must not read the process-wide Active model, which may differ from the originating Session.
      const assertProviderAvailable = async (): Promise<void> => undefined
      const prepareScope = async (
        input: DelegateExecutionInput
      ): Promise<PreparedProductionFrameworkScope> => {
        const permissionPrompts = options.resolvePermissionPrompts?.(input.session.sessionId)
        if (!input.workspaceCwd) throw new Error('Delegated Attempt has no prepared Frame cwd.')
        if (!input.executionModel) {
          throw new Error('Delegated Attempt has no admitted model snapshot.')
        }
        ownership.assertClear({ ...input.session, frameId: input.frameId })
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
        const removeRuntimeHome = async (): Promise<void> => {
          // OpenCode copies Main's read-only Skills even without a Specialist. Clear only
          // this Attempt's projection before removing its home, also after partial setup.
          if (frameworkId === 'opencode') {
            await makeRuntimeCopyRemovable(runtimeHome)
          }
          await rm(runtimeHome, { recursive: true, force: true })
        }
        let openCodeRuntime: PreparedOpenCodeRuntime | undefined
        let preparedSkills: AcpRuntimeCompositionOptions['preparedSkills']
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
          if (frameworkId === 'opencode') {
            openCodeRuntime = await prepareOpenCodeRuntime(backend, runtimeHome)
          }
          // Spawn preparation copies authentication/configuration first; project Skills afterwards
          // so copied Main configuration cannot overwrite the Attempt-owned bound packages.
          const delegatedSpawn = await backend.framework.prepareDelegatedSpawn?.(
            backend,
            runtimeHome
          )
          let runtimeBackend = openCodeRuntime?.backend ?? backend
          if (input.profile) {
            const specialist = await options.runtime.specialistService?.resolveRunnableById(
              input.profile
            )
            const prepareSkills = options.runtime.settingsService.prepareDelegatedSkills
            if (!specialist?.enabled || !prepareSkills)
              throw new Error('Delegated Specialist Skill preparation is unavailable.')
            const effective = resolveEffectiveSpecialistSkills(
              specialist,
              await options.runtime.settingsService.listSpecialistSkillCatalog()
            )
            if (effective.kind !== 'specialist')
              throw new Error('Delegated Specialist Skill scope is unavailable.')
            const root =
              frameworkId === 'opencode'
                ? join(runtimeHome, 'config', 'opencode')
                : frameworkId === 'codebuddy'
                  ? join(runtimeHome, 'codebuddy', 'skill-runtime')
                  : frameworkId === 'codex'
                    ? runtimeHome
                    : join(runtimeHome, 'skill-runtime')
            const configRoot =
              frameworkId === 'claude-code' || frameworkId === 'codebuddy'
                ? join(root, '.claude')
                : root
            preparedSkills = await prepareSkills.call(
              options.runtime.settingsService,
              configRoot,
              effective.skillIds
            )
            const sessionOptions = runtimeBackend.sessionOptions ?? {}
            const skillRuntime = sessionOptions[OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION] as
              Record<string, unknown> | undefined
            if (frameworkId === 'claude-code' || frameworkId === 'codex') {
              if (
                typeof skillRuntime?.command !== 'string' ||
                typeof skillRuntime.entryPath !== 'string'
              )
                throw new Error('Delegated Specialist Skill loader is unavailable.')
            }
            const sandbox = sessionOptions.sandbox as Record<string, unknown> | undefined
            const filesystem = sandbox?.filesystem as Record<string, unknown> | undefined
            const replaceRoot = (paths: unknown): string[] => [
              ...(Array.isArray(paths)
                ? paths.filter(
                    (path): path is string =>
                      typeof path === 'string' && path !== skillRuntime?.root
                  )
                : []),
              root
            ]
            runtimeBackend = {
              ...runtimeBackend,
              ...(delegatedSpawn ? { env: delegatedSpawn.env } : {}),
              sessionOptions: {
                ...sessionOptions,
                [OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION]: {
                  ...skillRuntime,
                  root,
                  skillsDirectory: join(configRoot, 'skills')
                },
                ...(frameworkId === 'claude-code'
                  ? {
                      additionalDirectories: replaceRoot(sessionOptions.additionalDirectories),
                      sandbox: {
                        ...sandbox,
                        filesystem: {
                          ...filesystem,
                          allowRead: replaceRoot(filesystem?.allowRead),
                          denyWrite: replaceRoot(filesystem?.denyWrite)
                        }
                      }
                    }
                  : {})
              }
            }
          }
          const capability = await options.notebookRpcServer().issueDelegatedNotebookConnection({
            permissionPrompts,
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
            backend: runtimeBackend,
            preparedSkills,
            connection: capability
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
            runtimeConstructionIsProcessFree:
              frameworkId === 'claude-code' || frameworkId === 'opencode',
            permissionPrompts,
            permissionProfile:
              options.resolvePermissionProfile?.(input.session.sessionId) ??
              durable.permissionProfile ??
              DEFAULT_PERMISSION_PROFILE,
            capability,
            ...(input.artifactCurrentRunFile
              ? { artifactCurrentRunFile: input.artifactCurrentRunFile }
              : {}),
            async confirmProcessCleanup() {
              await ownership.recover({ ...input.session, attemptId: input.attemptId }, true)
              ownership.assertClear({ ...input.session, attemptId: input.attemptId })
            },
            async releaseResources() {
              preparedAttempts.delete(input.attemptId)
              if (releaseResolvedBackend) await releaseResolvedAgentBackendLeases(backend)
            },
            async disposeResources() {
              ownership.assertClear({ ...input.session, attemptId: input.attemptId })
              // Port ownership also outlives a possibly surviving or still-starting child.
              openCodeRuntime?.dispose()
              try {
                // OpenCode copies read-only Skills into its config tree; the cleanup below
                // restores directory permissions while skipping remaining symlinks.
                if (frameworkId !== 'opencode') await preparedSkills?.dispose()
              } finally {
                await removeRuntimeHome()
              }
            }
          }
          if (delegatedSpawn)
            return {
              ...base,
              spawn: {
                ...delegatedSpawn,
                spawnProcess: (command, args, spawnOptions) =>
                  ownership.spawn(
                    {
                      ...input.session,
                      frameId: input.frameId,
                      attemptId: input.attemptId,
                      frameworkId
                    },
                    command,
                    args,
                    spawnOptions
                  )
              }
            }
          if (frameworkId === 'claude-code') {
            return { ...base, sessionSetup: sessionSetup(runtimeBackend) }
          }
          if (frameworkId === 'opencode') {
            return { ...base, modelConfig: openCodeRuntime!.modelConfig }
          }
          throw new Error(
            `Delegated-work framework ${frameworkId} does not prepare an execution scope.`
          )
        } catch (error) {
          if (frameworkId !== 'opencode') await preparedSkills?.dispose().catch(() => undefined)
          openCodeRuntime?.dispose()
          preparedAttempts.delete(input.attemptId)
          if (releaseResolvedBackend) await releaseResolvedAgentBackendLeases(backend)
          try {
            await removeRuntimeHome()
          } catch {
            /* Preserve the preparation failure. */
          }
          throw error
        }
      }
      const prepare = (input: DelegateExecutionInput): Promise<PreparedProductionFrameworkScope> =>
        ownership.withWorkspace({ ...input.session, frameId: input.frameId }, () =>
          prepareScope(input)
        )
      const createRuntime = (
        scope: PreparedProductionFrameworkScope,
        callbacks: AcpDelegateExecutionCallbacks,
        agentProcess?: ChildProcessWithoutNullStreams
      ): ReturnType<typeof createAcpRuntime> => {
        const owned = preparedAttempts.get(scope.executionId)
        if (!owned) throw new Error('Delegated runtime scope is unavailable.')
        let initialProcess = agentProcess
        const backend = withDelegatedChildContext(owned.backend)
        const spawnOwned = (): ChildProcessWithoutNullStreams => {
          if (initialProcess) {
            const process = initialProcess
            initialProcess = undefined
            return process
          }
          return backend.framework.spawn({
            ...(scope.spawn ?? {
              executablePath: backend.executablePath,
              args: backend.args ?? [],
              env: backend.env,
              proxyEnvironmentMode: backend.proxyEnvironmentMode
            }),
            spawnProcess: (command, args, spawnOptions) =>
              ownership.spawn(
                {
                  projectId: scope.provenance.projectId,
                  sessionId: scope.provenance.sessionId,
                  frameId: scope.provenance.agentFrameId,
                  attemptId: scope.executionId,
                  frameworkId
                },
                command,
                args,
                spawnOptions
              )
          })
        }
        return createAcpRuntime({
          ...options.runtime,
          notebookRpcServer: options.notebookRpcServer(),
          fixedBackend: backend,
          preparedSkills: owned.preparedSkills,
          runtimeCallbacks: callbacks,
          delegatedNotebookConnection: owned.connection,
          permissionGrantContext: {
            projectId: scope.provenance.projectId,
            sessionId: scope.provenance.sessionId
          },
          ...(scope.artifactCurrentRunFile
            ? { delegatedArtifactCurrentRunFile: scope.artifactCurrentRunFile }
            : {}),
          spawnAgent: spawnOwned
        })
      }

      return {
        frameworkId,
        assertProviderAvailable,
        prepare,
        createRuntime
      }
    }
  })
}

export {
  createProductionDelegatedFrameworkRuntime,
  DELEGATED_CHILD_SYSTEM_PROMPT_APPEND,
  withDelegatedChildContext
}
export type { ProductionFrameworkRuntimeOptions }
