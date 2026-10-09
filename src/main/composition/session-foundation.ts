import { app, dialog } from 'electron'
import type {
  SensitiveContentEvidence,
  SensitiveContentFailure,
  SensitiveContentSource
} from '../../shared/session-diagnostics'
import { createAcpRuntime } from '../acp/runtime-composition'
import { type ApplicationModuleBuilder } from '../application-runtime'
import { createLogger, diagnosticErrorFields, getLogFilePath } from '../logger'
import { getProjectDbClient } from '../projects/prisma-client'
import { broadcastToRenderers } from '../renderer-broadcast'
import { createSessionDiagnosticsDesktop } from '../session-diagnostics/desktop'
import createDiagnosticsWorker from '../session-diagnostics/worker-entry?nodeWorker'
import type { PackageSensitiveContentSource } from '../session-package/sensitive-content'
import {
  SessionAuxiliaryTurnUsageRecorder,
  type SessionAuxiliaryTurnUsageRecord
} from '../session-persistence/auxiliary-turn-usage'
import { createDefaultSessionRepository } from '../session-persistence/ipc'
import { SettingsService } from '../settings/service'
import { SideChatRuntimeOwner } from '../side-chat/runtime-owner'
import { UserSkillCatalogObserver } from '../skills/user-skill-catalog-observer'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'

export async function composeSessionFoundation({
  settingsService,
  runtimeRef,
  modules
}: {
  settingsService: SettingsService
  runtimeRef: { current: ReturnType<typeof createAcpRuntime> | undefined }
  modules: ApplicationModuleBuilder
}): Promise<{
  userSkillCatalogObserverRef: { current: UserSkillCatalogObserver | undefined }
  requestSkillCatalogRefresh: () => void
  sideChatOwnerRef: { current: SideChatRuntimeOwner | undefined }
  sessionRepository: ReturnType<typeof createDefaultSessionRepository>
  auxiliaryUsageRecorder: SessionAuxiliaryTurnUsageRecorder
  recordAuxiliaryUsage: (record: SessionAuxiliaryTurnUsageRecord) => Promise<void>
  rememberSensitiveContentFailure: (
    request: { projectId: string; sessionId: string },
    evidence: SensitiveContentEvidence[],
    sources: PackageSensitiveContentSource[]
  ) => void
  sessionDiagnosticsDesktop: import('../session-diagnostics/desktop').SessionDiagnosticsDesktop
}> {
  const userSkillCatalogObserverRef: { current: UserSkillCatalogObserver | undefined } = {
    current: undefined
  }
  const requestSkillCatalogRefresh = (): void => {
    const observer = userSkillCatalogObserverRef.current
    if (observer) {
      void observer.notifyCatalogChanged()
      return
    }
    if (runtimeRef.current) {
      void settingsService
        .registeredHelperCatalog()
        .refresh()
        .then(() => {
          broadcastToRenderers('skills:catalog-changed', undefined)
          return runtimeRef.current?.requestSkillsReload()
        })
        .catch((error) => {
          createLogger('skills').warn(
            'Skill catalog reconciliation failed',
            diagnosticErrorFields(error)
          )
        })
    }
  }
  const sideChatOwnerRef: { current: SideChatRuntimeOwner | undefined } = {
    current: undefined
  }
  const sessionRepository = createDefaultSessionRepository(
    (projectId, sessionId) =>
      (runtimeRef.current?.hasActiveSessionOperation(projectId, sessionId) ?? false) ||
      (runtimeRef.current?.getActivePromptSessions() ?? []).some(
        (session) => session.projectId === projectId && session.sessionId === sessionId
      ),
    // Preference saves and Resume use this predicate directly before committing restart
    // recovery, independently of the ordinary-read active-prompt predicate above.
    (projectId, sessionId) =>
      (runtimeRef.current?.hasActiveSessionOperation(projectId, sessionId) ?? false) ||
      (runtimeRef.current?.hasLiveSession(projectId, sessionId) ?? false)
  )
  const auxiliaryUsageLog = createLogger('session-usage:auxiliary')
  const auxiliaryUsageRecorder = new SessionAuxiliaryTurnUsageRecorder(() =>
    getProjectDbClient(resolveConfigRoot())
  )
  const recordAuxiliaryUsage = async (record: SessionAuxiliaryTurnUsageRecord): Promise<void> => {
    try {
      await auxiliaryUsageRecorder.record(record)
    } catch (error) {
      auxiliaryUsageLog.warn('auxiliary turn Usage persistence failed', {
        source: record.source,
        ...diagnosticErrorFields(error)
      })
    }
  }
  const sensitiveContentFailures = new Map<
    string,
    { failure: SensitiveContentFailure; sources: SensitiveContentSource[] }
  >()
  const sensitiveContentKey = (projectId: string, sessionId: string): string =>
    `${projectId}\0${sessionId}`
  const rememberSensitiveContentFailure = (
    request: { projectId: string; sessionId: string },
    evidence: SensitiveContentEvidence[],
    sources: PackageSensitiveContentSource[]
  ): void => {
    sensitiveContentFailures.set(sensitiveContentKey(request.projectId, request.sessionId), {
      failure: {
        occurredAt: new Date().toISOString(),
        evidence: evidence.slice(0, 20)
      },
      sources: sources.slice(0, 20).map((source) => ({ ...source }))
    })
    while (sensitiveContentFailures.size > 128) {
      const oldest = sensitiveContentFailures.keys().next().value
      if (oldest === undefined) break
      sensitiveContentFailures.delete(oldest)
    }
  }
  const sessionDiagnosticsDesktop = await modules.add(undefined, () => {
    const owner = createSessionDiagnosticsDesktop({
      createWorker: createDiagnosticsWorker,
      resolveSources: (identity) => {
        const sensitiveContent = sensitiveContentFailures.get(
          sensitiveContentKey(identity.projectId, identity.sessionId)
        )
        return {
          dataRoot: resolveDataRoot(),
          configRoot: resolveConfigRoot(),
          logPath: getLogFilePath(),
          appVersion: app.getVersion(),
          sensitiveContent: sensitiveContent?.failure,
          sensitiveContentSources: sensitiveContent?.sources
        }
      },
      chooseDestination: async (defaultName) => {
        const result = await dialog.showSaveDialog({ defaultPath: defaultName })
        return result.canceled ? undefined : result.filePath
      }
    })
    return { name: 'session-diagnostics', capability: owner, dispose: () => owner.close() }
  })
  return {
    userSkillCatalogObserverRef,
    requestSkillCatalogRefresh,
    sideChatOwnerRef,
    sessionRepository,
    auxiliaryUsageRecorder,
    recordAuxiliaryUsage,
    rememberSensitiveContentFailure,
    sessionDiagnosticsDesktop
  }
}
