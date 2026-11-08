import { useNavigationStore } from '@/stores/navigation-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { useProjectStore } from '@/stores/project-store'
import { useSessionReplayStore } from '@/stores/session-replay-store'
import { useSessionStore } from '@/stores/session-store'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Annotation } from '../../../../shared/annotation-contract'
import type { AnnotationValidationError } from '../../../../shared/annotations'
import {
  subscribeAnnotationReveal,
  subscribeAnnotationRevealPreparation
} from './annotations/annotation-reveal'
import { annotationValidationMessage } from './annotations/annotation-validation-message'
import { removeComposerDrafts } from './composer-draft-storage'
import { requestComposerFocus } from './composer-focus-events'
import type { ComposerDoc } from './composer/composer-doc'
import { persistedDiscussionCapture, requestReplaySeek } from './replay/replay-context'
import {
  createSessionDiscussionAnnotation,
  replayAnnotationTarget
} from './session-discussion-annotation'
import { createSessionReplayItem, DISCUSSION_DRAFT_CONFLICT } from './workspace-session-actions'

type DiscussionComposer = {
  view: { doc: ComposerDoc; annotations: Annotation[] }
  lifecycle: { discussionDraftConflict(projectId: string, sourceId: string): boolean }
  actions: {
    changeDoc(doc: ComposerDoc): void
    addAnnotation(annotation: Annotation): AnnotationValidationError | undefined
    setError(error: string | null): void
  }
}

export const useWorkspaceSessionDiscussion = ({
  composer,
  draftKey,
  editable
}: {
  composer: DiscussionComposer
  draftKey: string
  editable: boolean
}): boolean => {
  const { t } = useTranslation()
  const pending = useSessionReplayStore((state) => state.pendingDiscussion)
  const destination = useSessionReplayStore((state) => state.discussionDestination)
  const targetSession = useSessionStore((state) =>
    state.sessions.find((row) => row.id === destination?.sessionId)
  )
  // A restored draft may have missed the deletion event while this client was offline.
  const draftSource = draftKey.startsWith('new:')
    ? composer.view.annotations
        .map(replayAnnotationTarget)
        .find((target) => target?.sourceSessionId.startsWith('import-'))
    : undefined
  const projectId = draftSource?.projectId
  const sourceId = draftSource?.sourceSessionId
  const sourcePresent = useSessionStore((state) =>
    Boolean(
      sourceId &&
      state.sessions.some((session) => session.projectId === projectId && session.id === sourceId)
    )
  )
  const lookup =
    typeof window.api?.sessionReplay?.get === 'function' && projectId && sourceId && !sourcePresent
      ? JSON.stringify([projectId, sourceId])
      : undefined
  const [checked, setChecked] = useState<string>()
  useEffect(() => {
    if (!lookup || !projectId || !sourceId) return
    let current = true
    void window.api.sessionReplay
      .get({ projectId, sourceSessionId: sourceId })
      .then((snapshot) => {
        if (current && snapshot.sourceStatus === 'deleted')
          removeComposerDrafts(projectId, sourceId)
      })
      .catch(() => {
        /* An unavailable source does not prove permanent deletion. */
      })
      .finally(() => {
        if (current) setChecked(lookup)
      })
    return () => {
      current = false
    }
  }, [lookup, projectId, sourceId])
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
      !pending ||
      !destination ||
      handled.current === pending ||
      targetSession?.contentLoaded === false
    )
      return
    const targetKey = destination.sessionId ?? `new:${destination.projectId}`
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
      const project = useProjectStore
        .getState()
        .projects.find((row) => row.id === destination.projectId)
      return (
        navigation.view === 'workspace' &&
        navigation.activeProjectId === destination.projectId &&
        navigation.explicitNavigationRevision === destination.navigationRevision &&
        sessions.selectedSessionId === destination.sessionId &&
        destination.sessionId !== pending.sourceSessionId &&
        Boolean(project && project.archivedAt === undefined) &&
        (!destination.sessionId ||
          Boolean(
            session &&
            !session.isPending &&
            !session.packageOrigin &&
            session.archivedAt === undefined
          )) &&
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
      !destination.sessionId &&
      composer.lifecycle.discussionDraftConflict(pending.projectId, pending.sourceSessionId)
    ) {
      composer.actions.setError(DISCUSSION_DRAFT_CONFLICT)
      useSessionReplayStore.getState().ask(undefined)
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
        context: { ...persistedDiscussionCapture(pending), id }
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
          if (useSessionReplayStore.getState().pendingDiscussion === pending)
            useSessionReplayStore.getState().ask(undefined)
          return
        }
        // Build on the latest draft after storage finishes. Typing during IPC must be retained.
        const doc = current.composer.view.doc
        const annotation = createSessionDiscussionAnnotation(pending, id)
        if (annotation) {
          const error = current.composer.actions.addAnnotation(annotation)
          if (error) {
            current.composer.actions.setError(annotationValidationMessage(error, t))
            useSessionReplayStore.getState().ask(undefined)
            return
          }
          current.composer.actions.changeDoc(doc)
          current.composer.actions.setError(null)
        } else {
          current.composer.actions.setError(t('The recorded evidence is unavailable.'))
          useSessionReplayStore.getState().ask(undefined)
          return
        }
        useSessionReplayStore.getState().ask(undefined)
      })
      .catch((reason: unknown) => {
        if (
          latest.current.draftKey === draftKey &&
          useSessionReplayStore.getState().pendingDiscussion === pending
        )
          latest.current.composer.actions.setError(
            reason instanceof Error ? reason.message : String(reason)
          )
        if (useSessionReplayStore.getState().pendingDiscussion === pending)
          useSessionReplayStore.getState().ask(undefined)
        if (handled.current === pending) handled.current = undefined
      })
  }, [
    composer.actions,
    composer.lifecycle,
    composer.view.doc,
    draftKey,
    editable,
    pending,
    destination,
    targetSession,
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
      const revealTarget = (position: typeof target, title = t('Research replay')): void => {
        usePreviewWorkbenchStore
          .getState()
          .upsertAndActivateItem(
            createSessionReplayItem(
              position.projectId,
              position.sourceSessionId,
              title,
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
          revealTarget(
            { ...snapshot, stepOffsetMs: snapshot.stepOffsetMs ?? 0 },
            snapshot.sourceTitle
          )
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
  return Boolean(
    (lookup && checked !== lookup) ||
    (pending &&
      destination &&
      (destination.sessionId ?? `new:${destination.projectId}`) === draftKey)
  )
}
