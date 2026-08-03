import { createHmac, randomBytes, randomUUID } from 'node:crypto'

import { app } from 'electron'

import {
  createIpcHandlerInstallationScope,
  ipcMainHandle,
  type IpcHandlerInstallation
} from '../ipc-handler-registry'

import type {
  AcpCancelPromptRequest,
  AcpCompactSessionRequest,
  AcpConnectRequest,
  AcpCreateSessionRequest,
  AcpDeleteSessionRequest,
  AcpPermissionResponse,
  AcpPromptRequest,
  AcpResumeSessionRequest,
  AcpRevokePermissionGrantRequest,
  AcpSetPermissionProfileRequest
} from '../../shared/acp'
import { DEFAULT_ARTIFACT_PROJECT_NAME } from '../../shared/artifacts'
import { AcpRuntimeCoordinator } from './runtime-coordinator'
import type { AcpCreateSessionWorkflow } from './create-session-workflow'
import { installAgentShutdownGuard } from './shutdown-guard'
import { ArtifactRepository } from '../artifacts/repository'
import type { TaskNotificationService } from '../notifications/task-notifications'
import { NotebookRunRepository } from '../notebook/repository'
import {
  NotebookRuntimeService,
  type NotebookRuntimeServiceOptions
} from '../notebook/runtime-service'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'
import { broadcastToRenderers } from '../renderer-broadcast'
import { createLogger, diagnosticErrorFields, errorLogFields } from '../logger'

const log = createLogger('acp')
const resumeLogHashKey = randomBytes(32)
const SAFE_RESUME_RPC_CODES = new Set([-32700, -32600, -32601, -32602, -32603, -32002])
const SAFE_RESUME_ERROR_KINDS = new Set([
  'resource_not_found',
  'not_found',
  'session_not_found',
  'conversation_not_found',
  'session_missing',
  'conversation_missing',
  'session_resume_failed',
  'conversation_restore_failed'
])
const SAFE_RESUME_SERVICES = new Set(['session', 'provider', 'mcp', 'transport'])

const safeRead = (value: object, key: string): unknown => {
  try {
    return (value as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

const normalizedDiagnosticToken = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
  return normalized || undefined
}

const resumeSessionHash = (sessionId: string): string =>
  createHmac('sha256', resumeLogHashKey).update(sessionId).digest('hex').slice(0, 12)

const resumeErrorDiagnosticFields = (error: unknown): Record<string, unknown> => {
  const fields: Record<string, unknown> = diagnosticErrorFields(error)
  if (typeof error !== 'object' || error === null) return fields

  const code = safeRead(error, 'code')
  if (typeof code === 'number' && Number.isFinite(code)) {
    fields.rpcCode = SAFE_RESUME_RPC_CODES.has(code) ? code : 'other'
  }

  const data = safeRead(error, 'data')
  if (typeof data !== 'object' || data === null) return fields

  const errorKind = normalizedDiagnosticToken(safeRead(data, 'errorKind'))
  if (errorKind) fields.errorKind = SAFE_RESUME_ERROR_KINDS.has(errorKind) ? errorKind : 'other'
  const service = normalizedDiagnosticToken(safeRead(data, 'service'))
  if (service) fields.service = SAFE_RESUME_SERVICES.has(service) ? service : 'other'
  return fields
}

const logResumeDiagnostic = (
  level: 'info' | 'error',
  message: string,
  data: Record<string, unknown>
): void => {
  try {
    log[level](message, data)
  } catch {
    // Diagnostics must never change the Resume result observed by the renderer.
  }
}

// Sends one runtime payload through the typed application-event compatibility facade.
const broadcast = broadcastToRenderers

const registerAcpIpcHandlerSet = (
  runtime: AcpRuntimeCoordinator,
  createSessionWorkflow: AcpCreateSessionWorkflow,
  taskNotifications?: TaskNotificationService
): void => {
  ipcMainHandle('acp:get-state', () => runtime.getSnapshot())
  ipcMainHandle('acp:connect', (_event, request: AcpConnectRequest) => runtime.connect(request))
  ipcMainHandle('acp:disconnect', () => runtime.disconnect())
  ipcMainHandle('acp:create-session', async (_event, request: AcpCreateSessionRequest) => {
    try {
      return await createSessionWorkflow.create(request)
    } catch (error) {
      // Route through the file logger (rotating main.log) so the failure survives in a packaged build,
      // not just the dev console. errorLogFields keeps the message + stack out of a `{}`. Guarded so a
      // throwing logger can never mask the original error the renderer must still receive.
      try {
        log.error('acp:create-session failed', errorLogFields(error))
      } catch {
        /* logging must never mask the real error */
      }
      throw error
    }
  })
  ipcMainHandle('acp:resume-session', async (_event, request: AcpResumeSessionRequest) => {
    const startedAt = Date.now()
    const context = {
      operationId: randomUUID(),
      sessionHash: resumeSessionHash(request.sessionId)
    }
    logResumeDiagnostic('info', 'acp:resume-session started', context)

    try {
      const result = await runtime.resumeSession(request)
      logResumeDiagnostic('info', 'acp:resume-session completed', {
        ...context,
        durationMs: Math.max(0, Date.now() - startedAt),
        frameworkId: result.frameworkId,
        contextReset: result.contextReset === true
      })
      return result
    } catch (error) {
      logResumeDiagnostic('error', 'acp:resume-session failed', {
        ...context,
        durationMs: Math.max(0, Date.now() - startedAt),
        ...resumeErrorDiagnosticFields(error)
      })
      throw error
    }
  })
  ipcMainHandle('acp:reset-session-context', (_event, request: AcpResumeSessionRequest) =>
    runtime.resetSessionContext(request)
  )
  ipcMainHandle('acp:compact-session', (_event, request: AcpCompactSessionRequest) =>
    runtime.compactSession(request)
  )
  // Prompt calls wait for the turn to stop, then return the latest snapshot.
  ipcMainHandle('acp:send-prompt', async (_event, request: AcpPromptRequest) => {
    // Continuations are main-process-owned. A renderer-supplied marker must never suppress a visible
    // user message or impersonate the handoff path.
    const rendererRequest = { ...request, continuation: undefined }
    // Remember the prompt's first line so a completion/failure notification can name the task.
    // If the runtime rejects before the turn starts (unknown session, another prompt in flight),
    // revert so a still-running turn keeps its own prompt's name.
    const tracked = taskNotifications?.trackPrompt(rendererRequest)

    try {
      await runtime.sendPrompt(rendererRequest)
    } catch (error) {
      if (tracked) taskNotifications?.untrackPrompt(rendererRequest.sessionId, tracked)
      throw error
    }

    return runtime.getSnapshot()
  })
  ipcMainHandle('acp:cancel', (_event, request: AcpCancelPromptRequest) =>
    runtime.cancelPrompt(request)
  )
  ipcMainHandle('acp:delete-session', async (_event, request: AcpDeleteSessionRequest) => {
    // The coordinator owns session disappearance notifications for delete, connection loss, and
    // retirement. Keeping that signal in one layer prevents a successful delete from firing twice.
    return runtime.deleteSession(request)
  })
  ipcMainHandle('acp:respond-permission', (_event, response: AcpPermissionResponse) =>
    runtime.respondToPermission(response)
  )
  ipcMainHandle('acp:set-permission-profile', (_event, request: AcpSetPermissionProfileRequest) =>
    runtime.setPermissionProfile(request)
  )
  ipcMainHandle('acp:revoke-permission-grant', (_event, request: AcpRevokePermissionGrantRequest) =>
    runtime.revokePermissionGrant(request)
  )
}

// Installs the renderer-callable Electron adapter over an already-constructed ACP coordinator.
const installAcpIpcHandlers = (
  runtime: AcpRuntimeCoordinator,
  createSessionWorkflow: AcpCreateSessionWorkflow,
  taskNotifications?: TaskNotificationService
): IpcHandlerInstallation => {
  const scope = createIpcHandlerInstallationScope()
  try {
    registerAcpIpcHandlerSet(runtime, createSessionWorkflow, taskNotifications)
    // Kill the agent child on quit so it never outlives the app as an orphaned process.
    return scope.complete(installAgentShutdownGuard(app, runtime))
  } catch (error) {
    scope.rollback()
    throw error
  }
}

// Creates the shared notebook runtime used by both renderer IPC and agent MCP calls.
type DefaultNotebookRuntimeServiceDeps = Pick<
  NotebookRuntimeServiceOptions,
  'getPackageMirror' | 'notebookRuntimeSettings'
>

const createDefaultNotebookRuntimeService = (
  deps: DefaultNotebookRuntimeServiceDeps = {}
): NotebookRuntimeService => {
  const dataRoot = resolveDataRoot()
  const artifactRepository = new ArtifactRepository(dataRoot)

  return new NotebookRuntimeService({
    configRoot: resolveConfigRoot(),
    dataRoot,
    projectName: DEFAULT_ARTIFACT_PROJECT_NAME,
    repository: new NotebookRunRepository(dataRoot),
    ...deps,
    // Region default for manage_packages when no mirror is configured.
    locale: app.getLocale(),
    appVersion: app.getVersion(),
    resolveArtifactPath: (request) =>
      artifactRepository.resolveSessionArtifactFilePath(
        request.projectName,
        request.sessionId,
        request.path
      ),
    callbacks: {
      onNotebookAvailable: (event) => broadcast('notebook:available', event),
      onNotebookChanged: (event) => broadcast('notebook:changed', event)
    }
  })
}

export { createDefaultNotebookRuntimeService, installAcpIpcHandlers }
