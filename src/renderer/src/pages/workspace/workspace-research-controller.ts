import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigationStore, type ResearchWorkspaceNavigation } from '@/stores/navigation-store'
import { useSessionStore } from '@/stores/session-store'
import { usePreviewWorkbenchStore, type PreviewToolItem } from '@/stores/preview-workbench-store'
import { researchWorkspaceKey, useResearchWorkspaceStore } from '@/stores/research-workspace-store'
import type { ResearchWorkspaceSnapshot } from '../../../../shared/research-workspace'

export const createResearchReplayItem = (
  projectId: string,
  sourceSessionId: string,
  title: string
): PreviewToolItem => ({
  id: `tool:${sourceSessionId}:replay`,
  type: 'tool',
  toolKind: 'replay',
  projectId,
  sessionId: sourceSessionId,
  replaySourceSessionId: sourceSessionId,
  title
})

export const researchDraftKey = (projectId: string, sourceSessionId: string): string =>
  `research:${projectId}:${sourceSessionId}`

export const isResearchNavigationCurrent = (
  projectId: string,
  revision: number,
  selectedSessionId: string | undefined
): boolean => {
  const navigation = useNavigationStore.getState()
  return (
    navigation.view === 'workspace' &&
    navigation.activeProjectId === projectId &&
    navigation.explicitNavigationRevision === revision &&
    useSessionStore.getState().selectedSessionId === selectedSessionId
  )
}

export const researchDiscussionBlocked = (snapshot?: ResearchWorkspaceSnapshot): boolean => {
  if (!snapshot) return false
  if (snapshot.discussionStatus === 'available') return false
  if (snapshot.discussionStatus === 'none' || snapshot.discussionStatus === 'creating')
    return snapshot.sourceStatus !== 'available'
  return true
}

export type ResearchWorkspaceController = {
  research?: ResearchWorkspaceNavigation
  snapshot?: ResearchWorkspaceSnapshot
  error?: string
  loading: boolean
  blocked: boolean
  draftKey?: string
  prepareDiscussion?: () => Promise<string>
  acceptDiscussion: (sessionId: string) => boolean
  recreateDiscussion: () => Promise<void>
  restoreDiscussion: () => Promise<void>
  retry: () => void
}

export const useWorkspaceResearchController = (
  projectId: string,
  persistenceReady: boolean
): ResearchWorkspaceController => {
  const { t } = useTranslation()
  const selectedSessionId = useSessionStore((state) => state.selectedSessionId)
  const selected = useSessionStore((state) =>
    state.sessions.find((session) => session.id === selectedSessionId)
  )
  const context = useNavigationStore((state) => state.researchWorkspace)
  const research = context?.projectId === projectId ? context : undefined
  const navigationRevision = useNavigationStore((state) => state.explicitNavigationRevision)
  const snapshot = useResearchWorkspaceStore((state) =>
    research
      ? state.snapshots[researchWorkspaceKey(projectId, research.sourceSessionId)]
      : undefined
  )
  // Only lifecycle/organization changes invalidate the source relation; streamed answer chunks do not.
  const lifecycleKey = useSessionStore((state) =>
    JSON.stringify(
      [research?.sourceSessionId, research?.discussionSessionId].map((id) => {
        const row = state.sessions.find((session) => session.id === id)
        return row ? [row.id, row.archivedAt ?? null, row.title] : null
      })
    )
  )
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const opened = useRef<string | undefined>(undefined)
  const resolved = useRef<string | undefined>(undefined)
  const prepared = useRef(
    new Map<
      string,
      { projectId: string; sourceSessionId: string; revision: number; selectedSessionId?: string }
    >()
  )
  const api = window.api?.researchWorkspaces
  const selectedLoaded = selected?.contentLoaded !== false
  const selectedImported = Boolean(selected?.packageOrigin)

  useEffect(() => {
    if (!api || !projectId || !persistenceReady) return
    let cancelled = false
    const observed = useResearchWorkspaceStore.getState().snapshots
    void api
      .list({ projectId })
      .then((rows) => {
        if (!cancelled)
          useResearchWorkspaceStore.getState().replaceProject(projectId, rows, observed)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [api, projectId, persistenceReady, refresh])

  useEffect(() => {
    const onFocus = (): void => setRefresh((value) => value + 1)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  useEffect(() => {
    if (!api || !projectId || !persistenceReady || !selectedLoaded) return
    const current = useNavigationStore.getState().researchWorkspace
    const inResearch =
      current?.projectId === projectId &&
      (selectedSessionId === current.discussionSessionId || !selectedSessionId)
    if (!inResearch && !selectedSessionId) {
      return
    }
    const resolutionKey = JSON.stringify([
      projectId,
      navigationRevision,
      inResearch ? current.sourceSessionId : selectedSessionId,
      lifecycleKey,
      refresh
    ])
    if (resolved.current === resolutionKey) return
    let cancelled = false
    const stillCurrent = (): boolean =>
      !cancelled && isResearchNavigationCurrent(projectId, navigationRevision, selectedSessionId)
    const open = async (): Promise<void> => {
      const selectedNow = useSessionStore
        .getState()
        .sessions.find((row) => row.id === selectedSessionId)
      const known = Object.values(useResearchWorkspaceStore.getState().snapshots).find(
        (row) => row.projectId === projectId && row.discussionSessionId === selectedSessionId
      )
      let sourceSessionId = inResearch
        ? current.sourceSessionId
        : selectedImported
          ? selectedSessionId
          : known?.sourceSessionId
      if (!sourceSessionId) {
        const observed = useResearchWorkspaceStore.getState().snapshots
        const rows = await api.list({ projectId })
        if (!stillCurrent()) return
        useResearchWorkspaceStore.getState().replaceProject(projectId, rows, observed)
        sourceSessionId = rows.find(
          (row) => row.discussionSessionId === selectedSessionId
        )?.sourceSessionId
      }
      if (!sourceSessionId || !stillCurrent()) {
        resolved.current = resolutionKey
        return
      }
      setLoading(true)
      const next = await api.get({ projectId, sourceSessionId })
      if (!stillCurrent()) return
      setError(undefined)
      resolved.current = resolutionKey
      useResearchWorkspaceStore.getState().put(next)
      if (next.discussionSession)
        useSessionStore.getState().upsertPersistedSession(next.discussionSession)
      const discussionSessionId = next.discussionSession?.id
      useNavigationStore.setState({
        researchWorkspace: {
          projectId,
          sourceSessionId,
          sourceTitle:
            next.sourceTitle ??
            (inResearch
              ? current.sourceTitle
              : selectedNow?.id === sourceSessionId
                ? selectedNow.title
                : undefined) ??
            t('Imported research'),
          discussionSessionId
        }
      })
      if (discussionSessionId) useSessionStore.getState().selectSession(discussionSessionId)
      else useSessionStore.getState().clearSelection()
      const entryKey = JSON.stringify([projectId, sourceSessionId, navigationRevision])
      if (opened.current !== entryKey) {
        opened.current = entryKey
        usePreviewWorkbenchStore
          .getState()
          .upsertAndActivateItem(
            createResearchReplayItem(projectId, sourceSessionId, t('Research replay'))
          )
      }
    }
    void open()
      .catch((reason: unknown) => {
        if (stillCurrent()) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [
    api,
    projectId,
    persistenceReady,
    selectedSessionId,
    selectedLoaded,
    selectedImported,
    navigationRevision,
    lifecycleKey,
    refresh,
    t
  ])

  const prepareDiscussion = useCallback(async (): Promise<string> => {
    if (!research || !api) throw new Error(t('The research discussion is unavailable.'))
    const intent = {
      projectId: research.projectId,
      sourceSessionId: research.sourceSessionId,
      revision: useNavigationStore.getState().explicitNavigationRevision,
      selectedSessionId: useSessionStore.getState().selectedSessionId
    }
    const next = await api.ensureDiscussion({
      projectId: research.projectId,
      sourceSessionId: research.sourceSessionId,
      title: t('Discussion: {{title}}', { title: research.sourceTitle })
    })
    if (!next.discussionSession || next.discussionStatus !== 'available')
      throw new Error(t('The research discussion is unavailable.'))
    useResearchWorkspaceStore.getState().put(next)
    useSessionStore.getState().upsertPersistedSession(next.discussionSession)
    prepared.current.set(next.discussionSession.id, intent)
    return next.discussionSession.id
  }, [api, research, t])

  const acceptDiscussion = useCallback((sessionId: string): boolean => {
    const intent = prepared.current.get(sessionId)
    if (!intent) return false
    prepared.current.delete(sessionId)
    const current = useNavigationStore.getState().researchWorkspace
    if (
      !current ||
      current.sourceSessionId !== intent.sourceSessionId ||
      !isResearchNavigationCurrent(intent.projectId, intent.revision, intent.selectedSessionId)
    )
      return false
    useNavigationStore.setState({
      researchWorkspace: { ...current, discussionSessionId: sessionId }
    })
    useSessionStore.getState().selectSession(sessionId)
    return true
  }, [])

  const recreateDiscussion = useCallback(async (): Promise<void> => {
    if (!research || !snapshot?.discussionSessionId || !api) return
    const revision = useNavigationStore.getState().explicitNavigationRevision
    const selectedId = useSessionStore.getState().selectedSessionId
    const next = await api.ensureDiscussion({
      projectId,
      sourceSessionId: research.sourceSessionId,
      title: t('Discussion: {{title}}', { title: research.sourceTitle }),
      recreateMissing: {
        expectedDiscussionSessionId: snapshot.discussionSessionId,
        expectedRevision: snapshot.linkRevision
      }
    })
    useResearchWorkspaceStore.getState().put(next)
    if (next.discussionSession)
      useSessionStore.getState().upsertPersistedSession(next.discussionSession)
    if (!isResearchNavigationCurrent(projectId, revision, selectedId)) return
    if (next.discussionSession) {
      useNavigationStore.setState({
        researchWorkspace: { ...research, discussionSessionId: next.discussionSession.id }
      })
      useSessionStore.getState().selectSession(next.discussionSession.id)
    }
    setRefresh((value) => value + 1)
  }, [api, projectId, research, snapshot, t])

  const restoreDiscussion = useCallback(async (): Promise<void> => {
    const discussion = snapshot?.discussionSession
    if (!discussion) return
    const updated = await window.api.sessions.updateArchive({
      projectId,
      sessionId: discussion.id,
      archived: false,
      expectedRevision: discussion.revision ?? 0
    })
    useSessionStore.getState().upsertPersistedSession(updated)
    setRefresh((value) => value + 1)
  }, [projectId, snapshot])

  return {
    research,
    snapshot,
    error: research || selectedImported ? error : undefined,
    loading: Boolean(research || selectedImported) && loading,
    blocked:
      Boolean(research || selectedImported) &&
      (Boolean(error) || researchDiscussionBlocked(snapshot)),
    draftKey:
      research && !selectedSessionId
        ? researchDraftKey(projectId, research.sourceSessionId)
        : undefined,
    prepareDiscussion: research && !selectedSessionId ? prepareDiscussion : undefined,
    acceptDiscussion,
    recreateDiscussion,
    restoreDiscussion,
    retry: () => {
      resolved.current = undefined
      setError(undefined)
      setRefresh((value) => value + 1)
    }
  }
}

export type { ResearchWorkspaceSnapshot }
