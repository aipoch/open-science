import { toSessionDiscussionSnapshot } from './replay/replay-context'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSessionStore } from '@/stores/session-store'
import { useProjectStore } from '@/stores/project-store'
import { useSessionReplayStore } from '@/stores/session-replay-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import type { ComposerDoc } from './composer/composer-doc'
import type { Annotation, AnnotationValidationError } from '../../../../shared/annotations'
import { annotationValidationMessage } from './annotations/annotation-validation-message'
import {
  subscribeAnnotationReveal,
  subscribeAnnotationRevealPreparation
} from './annotations/annotation-reveal'
import {
  createSessionDiscussionAnnotation,
  replayAnnotationTarget
} from './session-discussion-annotation'
import { requestReplaySeek } from './replay/replay-context'
import { createSessionReplayItem, loadSessionDiscussionContext } from './workspace-session-actions'
import type { ResearchMembership } from '../../../../shared/session-persistence'
import { researchDraftKey, sameResearch } from './research-draft-identity'
import { researchSourceFromSession } from './workspace-discussion-navigation'
import { requestComposerFocus } from './composer-focus-events'

type DiscussionComposer = {
  view: { doc: ComposerDoc; annotations: Annotation[] }
  actions: {
    changeDoc(doc: ComposerDoc): void
    addAnnotation(annotation: Annotation): AnnotationValidationError | undefined
    setError(error: string | null): void
  }
}

export const useWorkspaceSessionDiscussion = ({
  composer,
  draftKey,
  editable,
  source
}: {
  composer: DiscussionComposer
  draftKey: string
  editable: boolean
  source?: ResearchMembership
}): {
  sourceContextPending: boolean
  sourceContextError?: string
  retrySourceContext(): void
} => {
  const { t } = useTranslation()
  const navigationRevision = useNavigationStore((state) => state.explicitNavigationRevision)
  const sourceKey = source ? researchDraftKey(source) : undefined
  const preparationKey = sourceKey ? JSON.stringify([sourceKey, navigationRevision]) : undefined
  const hasSourceContext = Boolean(
    source &&
    composer.view.annotations.some((annotation) => {
      const target = replayAnnotationTarget(annotation)
      return (
        target?.projectId === source.sourceProjectId &&
        target.sourceSessionId === source.sourceSessionId
      )
    })
  )
  const [preparedSourceKey, setPreparedSourceKey] = useState<string>()
  const [sourceContextError, setSourceContextError] = useState<{ key: string; message: string }>()
  const [retryRevision, setRetryRevision] = useState(0)
  const pendingSourceContext = useSessionReplayStore(
    (state) =>
      state.discussionDestination?.draftKey === sourceKey && Boolean(state.pendingDiscussion)
  )
  // Exact source links also expose the inline question draft. Prepare the same durable reference
  // used by explicit Discuss actions without changing selection or creating a Session.
  useEffect(() => {
    if (!source || !sourceKey || !editable || hasSourceContext || pendingSourceContext) return
    if (preparedSourceKey === preparationKey || sourceContextError?.key === sourceKey) return
    const controller = new AbortController()
    const navigation = useNavigationStore.getState()
    const current = (): boolean => {
      const now = useNavigationStore.getState()
      const sessions = useSessionStore.getState()
      const selected = sessions.sessions.find((row) => row.id === sessions.selectedSessionId)
      return (
        !controller.signal.aborted &&
        now.view === 'workspace' &&
        now.activeProjectId === source.sourceProjectId &&
        now.explicitNavigationRevision === navigation.explicitNavigationRevision &&
        sameResearch(researchSourceFromSession(selected), source) &&
        selected?.archivedAt === undefined
      )
    }
    void loadSessionDiscussionContext(
      source.sourceProjectId,
      source.sourceSessionId,
      controller.signal
    )
      .then((context) => {
        if (!current()) return
        const replay = useSessionReplayStore.getState()
        if (
          context &&
          (!replay.pendingDiscussion || replay.discussionDestination?.draftKey !== sourceKey)
        )
          useSessionReplayStore.getState().ask(context, {
            projectId: source.sourceProjectId,
            draftKey: sourceKey,
            onlyIfUnlinked: true,
            navigationRevision: navigation.explicitNavigationRevision
          })
        setPreparedSourceKey(preparationKey)
      })
      .catch((reason: unknown) => {
        if (!current()) return
        const message = reason instanceof Error ? reason.message : String(reason)
        composer.actions.setError(message)
        setSourceContextError({ key: sourceKey, message })
      })
    return () => controller.abort()
  }, [
    source,
    sourceKey,
    preparationKey,
    navigationRevision,
    editable,
    hasSourceContext,
    pendingSourceContext,
    preparedSourceKey,
    sourceContextError,
    retryRevision,
    composer.actions
  ])
  const draftSource = composer.view.annotations.map(replayAnnotationTarget).filter(Boolean).at(-1)
  const draftProjectId = draftSource?.projectId
  const draftSourceId = draftSource?.sourceSessionId
  useEffect(() => {
    if (!editable || !draftProjectId || !draftSourceId) return
    const draftDiscussion = {
      projectId: draftProjectId,
      sourceSessionId: draftSourceId,
      draftKey
    }
    useSessionReplayStore.setState({ draftDiscussion })
    return () => {
      if (useSessionReplayStore.getState().draftDiscussion === draftDiscussion)
        useSessionReplayStore.setState({ draftDiscussion: undefined })
    }
  }, [editable, draftKey, draftProjectId, draftSourceId])
  const pending = useSessionReplayStore((state) => state.pendingDiscussion)
  const destination = useSessionReplayStore((state) => state.discussionDestination)
  const targetSession = useSessionStore((state) =>
    state.sessions.find((row) => row.id === destination?.sessionId)
  )
  const mounted = useRef(true)
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const handled = useRef<typeof pending>(undefined)
  const savedContextIds = useRef(new WeakMap<object, string>())
  const latest = useRef({ composer, draftKey, editable })
  useLayoutEffect(() => {
    latest.current = { composer, draftKey, editable }
  })

  useEffect(() => {
    if (
      !editable ||
      sourceContextError?.key === draftKey ||
      !pending ||
      !destination ||
      handled.current === pending ||
      targetSession?.contentLoaded === false
    )
      return
    const targetKey =
      destination.sessionId ?? destination.draftKey ?? `new:${destination.projectId}`
    if (draftKey !== targetKey) return
    const selectedFrame = (): string => {
      const graph = useSessionStore
        .getState()
        .sessions.find((row) => row.id === destination.sessionId)?.conversationGraph
      const frame = graph?.frames.find((row) => row.id === graph.activeFrameId)
      return JSON.stringify([frame?.id, frame?.activeBranchId])
    }
    const frameAtStart = selectedFrame()
    const destinationCurrent = (): boolean => {
      const navigation = useNavigationStore.getState()
      const sessions = useSessionStore.getState()
      const session = sessions.sessions.find((row) => row.id === destination.sessionId)
      const selected = sessions.sessions.find((row) => row.id === sessions.selectedSessionId)
      const selectedSource = researchSourceFromSession(selected)
      const inlineSourceDraft =
        !destination.sessionId &&
        selectedSource &&
        selected?.archivedAt === undefined &&
        destination.projectId === selectedSource.sourceProjectId &&
        destination.draftKey === researchDraftKey(selectedSource)
      const project = useProjectStore
        .getState()
        .projects.find((row) => row.id === destination.projectId)
      return (
        navigation.view === 'workspace' &&
        navigation.activeProjectId === destination.projectId &&
        navigation.explicitNavigationRevision === destination.navigationRevision &&
        (sessions.selectedSessionId === destination.sessionId || Boolean(inlineSourceDraft)) &&
        destination.sessionId !== pending.sourceSessionId &&
        Boolean(project && project.archivedAt === undefined) &&
        (!destination.sessionId ||
          Boolean(session && !session.packageOrigin && session.archivedAt === undefined)) &&
        selectedFrame() === frameAtStart &&
        (!destination.frameId ||
          frameAtStart === JSON.stringify([destination.frameId, destination.branchId]))
      )
    }
    if (!destinationCurrent()) {
      useSessionReplayStore.getState().ask(undefined)
      return
    }
    if (
      destination.onlyIfUnlinked &&
      composer.view.annotations.some((annotation) => {
        const source = replayAnnotationTarget(annotation)
        return (
          source?.projectId === pending.projectId &&
          source.sourceSessionId === pending.sourceSessionId
        )
      })
    ) {
      useSessionReplayStore.getState().ask(undefined)
      // Re-entering an already linked draft still admits an explicit discussion action.
      // Restore typing focus without replacing its chosen evidence or saving another snapshot.
      requestComposerFocus()
      return
    }
    handled.current = pending
    // Focus at admission, not after IPC: users may navigate the replay while storage finishes.
    requestComposerFocus()
    const id = savedContextIds.current.get(pending) ?? crypto.randomUUID()
    savedContextIds.current.set(pending, id)
    void window.api.sessionReplay
      .saveSelectionSnapshot({
        projectId: pending.projectId,
        sourceSessionId: pending.sourceSessionId,
        context: toSessionDiscussionSnapshot(pending, id)
      })
      .then(() => {
        const current = latest.current
        if (
          useSessionReplayStore.getState().pendingDiscussion !== pending ||
          !mounted.current ||
          !current.editable ||
          current.draftKey !== draftKey ||
          !destinationCurrent()
        ) {
          if (useSessionReplayStore.getState().pendingDiscussion === pending) {
            useSessionReplayStore.getState().ask(undefined)
          }
          return
        }
        // Build on the latest draft after storage finishes. Typing during IPC must be retained.
        const doc = current.composer.view.doc
        const annotation = createSessionDiscussionAnnotation(pending, id)
        if (annotation) {
          const error = current.composer.actions.addAnnotation(annotation)
          if (error) {
            const message = annotationValidationMessage(error, t)
            current.composer.actions.setError(message)
            if (sourceKey === draftKey) setSourceContextError({ key: sourceKey, message })
            return
          }
          current.composer.actions.changeDoc(doc)
          current.composer.actions.setError(null)
        } else {
          const message = t('The recorded evidence is unavailable.')
          current.composer.actions.setError(message)
          if (sourceKey === draftKey) setSourceContextError({ key: sourceKey, message })
          useSessionReplayStore.getState().ask(undefined)
          return
        }
        useSessionReplayStore.getState().ask(undefined)
      })
      .catch((reason: unknown) => {
        if (
          latest.current.draftKey === draftKey &&
          useSessionReplayStore.getState().pendingDiscussion === pending
        ) {
          const message = reason instanceof Error ? reason.message : String(reason)
          latest.current.composer.actions.setError(message)
          if (sourceKey === draftKey) setSourceContextError({ key: sourceKey, message })
        }
        if (handled.current === pending) handled.current = undefined
      })
  }, [
    composer.actions,
    composer.view.annotations,
    composer.view.doc,
    draftKey,
    editable,
    pending,
    destination,
    navigationRevision,
    targetSession,
    sourceKey,
    retryRevision,
    sourceContextError,
    t
  ])

  useEffect(() => {
    let claimed: string | undefined
    let generation = 0
    let disposed = false
    const prepare = subscribeAnnotationRevealPreparation((annotation) => {
      const target = replayAnnotationTarget(annotation)
      const navigation = useNavigationStore.getState()
      if (!target || !navigation.activeProjectId || navigation.view !== 'workspace') return
      claimed = annotation.id
      const request = ++generation
      const revision = navigation.explicitNavigationRevision
      const stillCurrent = (): boolean => {
        const current = useNavigationStore.getState()
        return (
          !disposed &&
          generation === request &&
          current.view === 'workspace' &&
          current.activeProjectId === navigation.activeProjectId &&
          current.explicitNavigationRevision === revision
        )
      }
      const revealTarget = (position: typeof target): void => {
        usePreviewWorkbenchStore
          .getState()
          .upsertAndActivateItem(
            createSessionReplayItem(
              position.projectId,
              position.sourceSessionId,
              t('Research replay'),
              navigation.activeProjectId
            )
          )
        requestReplaySeek(position)
      }
      if (!target.contextId) {
        revealTarget(target)
        return
      }
      void window.api.sessionReplay
        .getSelectionSnapshot({ projectId: target.projectId, id: target.contextId })
        .then((snapshot) => {
          if (!stillCurrent()) return
          if (
            !snapshot ||
            snapshot.projectId !== target.projectId ||
            snapshot.sourceSessionId !== target.sourceSessionId ||
            snapshot.branchId !== target.branchId ||
            snapshot.stepId !== target.stepId ||
            (snapshot.stepOffsetMs ?? 0) !== (target.stepOffsetMs ?? 0)
          ) {
            latest.current.composer.actions.setError(
              t('This replay reference is unavailable on this device.')
            )
            return
          }
          revealTarget({ ...snapshot, stepOffsetMs: snapshot.stepOffsetMs ?? 0 })
        })
        .catch(() => {
          if (stillCurrent())
            latest.current.composer.actions.setError(
              t('This replay reference is unavailable on this device.')
            )
        })
    })
    const reveal = subscribeAnnotationReveal((id) => {
      if (id !== claimed) return false
      claimed = undefined
      return true
    })
    return () => {
      disposed = true
      generation++
      prepare()
      reveal()
    }
  }, [t])
  return {
    sourceContextPending: Boolean(
      sourceKey &&
      (pendingSourceContext ||
        sourceContextError?.key === sourceKey ||
        (!hasSourceContext && preparedSourceKey !== preparationKey))
    ),
    sourceContextError:
      sourceContextError && sourceContextError.key === sourceKey
        ? sourceContextError.message
        : undefined,
    retrySourceContext: () => {
      handled.current = undefined
      setPreparedSourceKey(undefined)
      setSourceContextError(undefined)
      composer.actions.setError(null)
      setRetryRevision((revision) => revision + 1)
    }
  }
}
