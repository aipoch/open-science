import { useCallback, useEffect, useState } from 'react'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSessionStore, type ChatSession } from '@/stores/session-store'
import { sessionExportLocked, usePackageOperationStore } from '@/stores/package-operation-store'
import { useResearchRunStore, type ResearchRunRequest } from '@/stores/research-run-store'
import type { NotebookRunRecord, NotebookSessionReference } from '../../../../shared/notebook'
import type { ResearchMembership } from '../../../../shared/session-persistence'
import { resolveTurnOutcome } from '../../../../shared/session-persistence'
import type { RunObservationTarget } from '../../../../shared/run-observation'
import { researchIdentity, sameResearch } from './research-draft-identity'
import { showRunObservation } from './replay/open-run-observation'

export type ResearchRunStage =
  'preparing' | 'running' | 'completed' | 'failed' | 'no-run' | 'unavailable'
export type ObservedResearchRun = ResearchRunRequest & { stage: ResearchRunStage }

/** Native managed research execution is narrower than arbitrary Notebook activity. Missing legacy
 * attribution is not evidence of ownership. Main reauthorizes the exact target when it is opened. */
export const matchesResearchRunRequest = (
  run: NotebookRunRecord,
  request: ResearchRunRequest
): boolean =>
  Boolean(
    request.promptMessageId &&
    run.promptMessageId === request.promptMessageId &&
    run.source === 'agent' &&
    run.kernelKind === 'bash' &&
    run.shellRuntime?.kind === 'native-posix' &&
    run.executionInvocationId?.startsWith('managed-') &&
    run.rootFrameId &&
    run.rootFrameId === run.agentFrameId
  )

export const findResearchRun = (
  runs: readonly NotebookRunRecord[],
  request: ResearchRunRequest
): NotebookRunRecord | undefined => {
  const eligible = runs.filter((run) => matchesResearchRunRequest(run, request))
  if (request.target)
    return eligible.find(
      (run) =>
        run.runId === request.target?.runId &&
        run.executionInvocationId === request.target.executionInvocationId
    )
  // The first admitted managed Run is sticky. A later retry or unrelated latest Run cannot silently
  // replace the operation whose live viewer was already opened for this request.
  return eligible.sort((a, b) => a.startedAt - b.startedAt || a.runId.localeCompare(b.runId))[0]
}

const sourceAvailable = (source: ResearchMembership, sessions: readonly ChatSession[]): boolean =>
  sessions.some(
    (session) =>
      session.id === source.sourceSessionId &&
      session.projectId === source.sourceProjectId &&
      session.archivedAt === undefined &&
      (session.packageOrigin?.importId ?? session.importedResearch?.importId) ===
        source.sourceImportId
  )

const destinationAvailable = (
  request: ResearchRunRequest,
  session:
    | Pick<
        ChatSession,
        | 'id'
        | 'projectId'
        | 'archivedAt'
        | 'packageOrigin'
        | 'importedResearch'
        | 'researchMembership'
      >
    | undefined
): boolean =>
  Boolean(
    session &&
    session.id === request.sessionId &&
    session.projectId === request.source.sourceProjectId &&
    session.archivedAt === undefined &&
    !session.packageOrigin &&
    !session.importedResearch &&
    sameResearch(session.researchMembership, request.source)
  )

/** Runtime admission can replace an optimistic Session long before the Agent turn finishes.
 * Recover that binding from the exact appended user Message, never the selected/latest Session. */
export const resolveResearchRunDestination = (
  request: ResearchRunRequest,
  sessions: readonly ChatSession[]
): string | undefined => {
  if (request.settled || !request.promptMessageId) return undefined
  const matches = sessions.filter(
    (session) =>
      !session.isPending &&
      destinationAvailable({ ...request, sessionId: session.id }, session) &&
      (session.conversationGraph?.messages ?? session.messages).some(
        (message) => message.id === request.promptMessageId && message.role === 'user'
      )
  )
  return matches.length === 1 ? matches[0].id : undefined
}

const requestIsCurrent = (request: ResearchRunRequest): boolean =>
  useResearchRunStore.getState().requests[researchIdentity(request.source)]?.requestId ===
  request.requestId

const runStage = (run: NotebookRunRecord): ResearchRunStage =>
  run.status === 'queued' || run.status === 'running'
    ? 'running'
    : run.status === 'completed'
      ? 'completed'
      : 'failed'

type Snapshot = {
  requestId: string
  sessionId: string
  target?: RunObservationTarget
  stage: ResearchRunStage
}

export const useResearchRunObserver = ({
  source,
  title
}: {
  source?: ResearchMembership
  title: string
}): {
  request?: ObservedResearchRun
  begin: (requestId: string, source: ResearchMembership) => void
  bind: (requestId: string, destination: { sessionId: string; messageId: string }) => void
  settle: (requestId: string, destination: { sessionId: string; messageId?: string }) => void
  reject: (requestId: string) => void
  open: () => boolean
  retry: () => void
} => {
  const key = source && researchIdentity(source)
  const request = useResearchRunStore((state) => (key ? state.requests[key] : undefined))
  const sessions = useSessionStore((state) => state.sessions)
  const selectedSessionId = useSessionStore((state) => state.selectedSessionId)
  const navigationRevision = useNavigationStore((state) => state.explicitNavigationRevision)
  const activeProjectId = useNavigationStore((state) => state.activeProjectId)
  const navigationView = useNavigationStore((state) => state.view)
  const session = sessions.find(
    (row) => row.id === request?.sessionId && row.projectId === source?.sourceProjectId
  )
  const validSource = Boolean(source && sourceAvailable(source, sessions))
  const validDestination = Boolean(request && destinationAvailable(request, session))
  const remappedSessionId = request && resolveResearchRunDestination(request, sessions)
  useEffect(() => {
    if (request && remappedSessionId && requestIsCurrent(request))
      useResearchRunStore.getState().settle(request.requestId, { sessionId: remappedSessionId })
  }, [request, remappedSessionId])
  const locked = usePackageOperationStore((state) => sessionExportLocked(state.operation, session))
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [retry, setRetry] = useState(0)
  const requestId = request?.requestId
  const projectId = source?.sourceProjectId
  const sessionId = request?.sessionId
  const promptMessageId = request?.promptMessageId
  const contentLoaded = session?.contentLoaded
  const workspaceCwd = session?.cwd ?? ''
  const isPending = session?.isPending
  const rejected = request?.rejected
  const promptOutcome = (session?.conversationGraph?.messages ?? session?.messages)?.find(
    (message) => message.id === promptMessageId && message.role === 'user'
  )?.turnOutcome?.kind

  useEffect(() => {
    if (
      !requestId ||
      !sessionId ||
      !promptMessageId ||
      !projectId ||
      isPending ||
      rejected ||
      !validSource ||
      !validDestination ||
      locked
    )
      return
    const api = window.api?.notebook
    let active = true
    let loading = false
    let queued = false
    let pollAgain = true
    let reference: NotebookSessionReference | null = null
    const currentRequest = (): ResearchRunRequest | undefined =>
      useResearchRunStore.getState().requests[key!]
    const publish = (stage: ResearchRunStage, target?: RunObservationTarget): void => {
      if (!active || currentRequest()?.requestId !== requestId) return
      setSnapshot({ requestId, sessionId, stage, target })
    }
    const noRunStage = async (latest: ResearchRunRequest): Promise<ResearchRunStage> => {
      if (promptOutcome) return promptOutcome === 'completed' ? 'no-run' : 'failed'
      if (contentLoaded !== false) return 'preparing'
      // Startup summaries omit prompt outcomes. Read exactly the recorded destination without
      // hydrating unrelated histories or changing the selected Session/draft.
      const recorded = await window.api?.sessions?.loadOne?.({ projectId, sessionId })
      if (
        !recorded ||
        !destinationAvailable(latest, recorded) ||
        !(recorded.conversationGraph?.messages ?? recorded.messages).some(
          (message) => message.id === promptMessageId && message.role === 'user'
        )
      )
        return 'unavailable'
      const outcome = resolveTurnOutcome(recorded, promptMessageId)
      if (outcome) return outcome.kind === 'completed' ? 'no-run' : 'failed'
      return recorded.activeRun?.promptMessageId === promptMessageId ||
        recorded.status === 'running' ||
        recorded.status.startsWith('waiting-')
        ? 'preparing'
        : 'unavailable'
    }
    const load = async (): Promise<void> => {
      if (!active) return
      if (loading) {
        queued = true
        return
      }
      loading = true
      try {
        const latest = currentRequest()
        if (!latest || latest.requestId !== requestId || latest.sessionId !== sessionId) return
        if (!api?.getReference || !api.state) {
          publish('unavailable')
          return
        }
        reference ??= await api.getReference({ projectId, sessionId, workspaceCwd })
        if (!active) return
        if (!reference) {
          const stage = await noRunStage(latest)
          pollAgain = stage === 'preparing'
          publish(stage)
          return
        }
        if (reference.sessionId !== sessionId || reference.projectId !== projectId) {
          publish('unavailable')
          return
        }
        const state = await api.state({
          ...reference,
          ...(latest.target?.runId ? { runIds: [latest.target.runId] } : {})
        })
        if (!active || currentRequest()?.requestId !== requestId) return
        if (state.sessionId !== sessionId) {
          publish('unavailable')
          return
        }
        const run = findResearchRun(state.runs, latest)
        if (!run) {
          const stage = latest.target ? 'unavailable' : await noRunStage(latest)
          pollAgain = stage === 'preparing'
          publish(stage)
          return
        }
        pollAgain = run.status === 'queued' || run.status === 'running'
        const target = {
          projectId,
          sessionId,
          runId: run.runId,
          executionInvocationId: run.executionInvocationId!
        }
        useResearchRunStore.getState().attach(requestId, target)
        publish(runStage(run), target)
      } catch {
        publish('unavailable')
      } finally {
        loading = false
        if (active && queued) {
          queued = false
          void load()
        }
      }
    }
    const onEvent = (event: NotebookSessionReference): void => {
      if (event.projectId !== projectId || event.sessionId !== sessionId) return
      reference = event
      void load()
    }
    const stopAvailable = api?.onAvailable?.(onEvent)
    const stopChanged = api?.onChanged?.(onEvent)
    void load()
    // Events are primary; a bounded repair poll handles an event delivered before registration.
    const timer = window.setInterval(() => {
      if (pollAgain) void load()
    }, 3000)
    return () => {
      active = false
      stopAvailable?.()
      stopChanged?.()
      window.clearInterval(timer)
    }
  }, [
    key,
    requestId,
    sessionId,
    promptMessageId,
    projectId,
    isPending,
    workspaceCwd,
    contentLoaded,
    rejected,
    validSource,
    validDestination,
    locked,
    promptOutcome,
    retry
  ])

  const currentSnapshot =
    snapshot?.requestId === requestId && snapshot?.sessionId === sessionId ? snapshot : undefined
  const target = validSource && validDestination && !locked ? currentSnapshot?.target : undefined
  useEffect(() => {
    if (
      !request ||
      !target ||
      request.autoOpenConsumed ||
      request.autoOpenNavigationRevision === undefined
    )
      return
    if (useResearchRunStore.getState().requests[researchIdentity(request.source)]?.autoOpenConsumed)
      return
    // Consume even if the user left before discovery. Returning later never hijacks a preview.
    useResearchRunStore.getState().consumeAutoOpen(request.requestId)
    if (
      navigationView !== 'workspace' ||
      activeProjectId !== projectId ||
      selectedSessionId !== sessionId ||
      navigationRevision !== request.autoOpenNavigationRevision
    )
      return
    showRunObservation(target, title)
  }, [
    request,
    target,
    navigationView,
    activeProjectId,
    projectId,
    selectedSessionId,
    sessionId,
    navigationRevision,
    title
  ])

  const open = useCallback((): boolean => {
    if (
      !request ||
      !target ||
      !requestIsCurrent(request) ||
      !sourceAvailable(request.source, useSessionStore.getState().sessions) ||
      !destinationAvailable(
        request,
        useSessionStore.getState().sessions.find((row) => row.id === request.sessionId)
      )
    )
      return false
    showRunObservation(target, title)
    return true
  }, [request, target, title])
  const stage: ResearchRunStage = request?.rejected
    ? 'failed'
    : !validSource || (request?.sessionId && !validDestination)
      ? 'unavailable'
      : (currentSnapshot?.stage ?? 'preparing')
  const actions = useResearchRunStore.getState()
  return {
    request: request ? { ...request, target, stage } : undefined,
    begin: actions.begin,
    bind: actions.bind,
    settle: actions.settle,
    reject: actions.reject,
    open,
    retry: () => setRetry((value) => value + 1)
  }
}
