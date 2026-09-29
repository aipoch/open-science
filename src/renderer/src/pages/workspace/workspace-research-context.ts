import { useEffect, useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigationStore } from '@/stores/navigation-store'
import { useResearchWorkspaceStore } from '@/stores/research-workspace-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import type { ComposerDoc } from './composer/composer-doc'
import type { Annotation, AnnotationValidationError } from '../../../../shared/annotations'
import { annotationValidationMessage } from './annotations/annotation-validation-message'
import {
  subscribeAnnotationReveal,
  subscribeAnnotationRevealPreparation
} from './annotations/annotation-reveal'
import {
  createReplayStepAnnotation,
  replayQuestionQuote,
  referenceReplaySource,
  replayAnnotationTarget
} from './research-replay-context'
import { requestReplaySeek } from './replay/replay-context'
import {
  createResearchReplayItem,
  type ResearchWorkspaceController
} from './workspace-research-controller'
import { requestComposerFocus } from './composer-focus-events'
import { replayReferenceText } from './replay-reference-text'

type ResearchComposer = {
  view: { doc: ComposerDoc; annotations: Annotation[] }
  actions: {
    changeDoc(doc: ComposerDoc): void
    addAnnotation(annotation: Annotation): AnnotationValidationError | undefined
    setError(error: string | null): void
  }
}

export const useWorkspaceResearchContext = ({
  controller,
  composer,
  draftKey,
  editable
}: {
  controller: ResearchWorkspaceController
  composer: ResearchComposer
  draftKey: string
  editable: boolean
}): void => {
  const { t } = useTranslation()
  const pending = useResearchWorkspaceStore((state) => state.pendingQuestion)
  const initialized = useRef(new Set<string>())
  const handled = useRef<typeof pending>(undefined)
  const savedContextIds = useRef(new WeakMap<object, string>())
  const { research } = controller
  const latest = useRef({ composer, draftKey, editable, research })
  useLayoutEffect(() => {
    latest.current = { composer, draftKey, editable, research }
  })

  useEffect(() => {
    if (!editable || !research) return
    const key = JSON.stringify([research.projectId, research.sourceSessionId, draftKey])
    if (initialized.current.has(key)) return
    initialized.current.add(key)
    try {
      composer.actions.changeDoc(referenceReplaySource(composer.view.doc, research))
    } catch {
      composer.actions.setError(t('Remove a session reference before adding this research.'))
    }
  }, [composer.actions, composer.view.doc, draftKey, editable, research, t])

  useEffect(() => {
    if (
      !editable ||
      !research ||
      !pending ||
      handled.current === pending ||
      pending.projectId !== research.projectId ||
      pending.sourceSessionId !== research.sourceSessionId
    )
      return
    handled.current = pending
    const revision = useNavigationStore.getState().explicitNavigationRevision
    const id = savedContextIds.current.get(pending) ?? crypto.randomUUID()
    savedContextIds.current.set(pending, id)
    void window.api.researchWorkspaces
      .saveQuestionContext({
        projectId: pending.projectId,
        sourceSessionId: pending.sourceSessionId,
        context: { ...structuredClone(pending), id }
      })
      .then(() => {
        const current = latest.current
        const navigation = useNavigationStore.getState()
        if (
          useResearchWorkspaceStore.getState().pendingQuestion !== pending ||
          !current.editable ||
          current.draftKey !== draftKey ||
          navigation.explicitNavigationRevision !== revision ||
          navigation.view !== 'workspace' ||
          navigation.activeProjectId !== pending.projectId ||
          current.research?.projectId !== pending.projectId ||
          current.research.sourceSessionId !== pending.sourceSessionId
        ) {
          if (handled.current === pending) handled.current = undefined
          return
        }
        // Build on the latest draft after storage finishes. Typing during IPC must be retained.
        const doc = referenceReplaySource(current.composer.view.doc, pending)
        const annotation = createReplayStepAnnotation(pending, id)
        if (annotation) {
          const error = current.composer.actions.addAnnotation(annotation)
          if (error) {
            current.composer.actions.setError(annotationValidationMessage(error, t))
            return
          }
          current.composer.actions.changeDoc(doc)
        } else {
          current.composer.actions.changeDoc({
            nodes: [
              ...doc.nodes,
              {
                type: 'text',
                text: `\n${replayReferenceText(id, t('Replay step reference'))}\n${replayQuestionQuote(pending, 12_000)}\n`
              }
            ]
          })
        }
        useResearchWorkspaceStore.getState().ask(undefined)
        requestComposerFocus()
      })
      .catch((reason: unknown) => {
        if (
          latest.current.draftKey === draftKey &&
          useResearchWorkspaceStore.getState().pendingQuestion === pending
        )
          latest.current.composer.actions.setError(
            reason instanceof Error ? reason.message : String(reason)
          )
        if (handled.current === pending) handled.current = undefined
      })
  }, [composer.actions, composer.view.doc, draftKey, editable, pending, research, t])

  useEffect(() => {
    let claimed: string | undefined
    let generation = 0
    let disposed = false
    const prepare = subscribeAnnotationRevealPreparation((annotation) => {
      const target = replayAnnotationTarget(annotation)
      const navigation = useNavigationStore.getState()
      if (
        !target ||
        target.projectId !== navigation.activeProjectId ||
        navigation.view !== 'workspace'
      )
        return
      claimed = annotation.id
      const request = ++generation
      const revision = navigation.explicitNavigationRevision
      const stillCurrent = (): boolean => {
        const current = useNavigationStore.getState()
        return (
          !disposed &&
          generation === request &&
          current.view === 'workspace' &&
          current.activeProjectId === target.projectId &&
          current.explicitNavigationRevision === revision
        )
      }
      const revealTarget = (position: typeof target): void => {
        usePreviewWorkbenchStore
          .getState()
          .upsertAndActivateItem(
            createResearchReplayItem(
              position.projectId,
              position.sourceSessionId,
              t('Research replay')
            )
          )
        requestReplaySeek(position)
      }
      if (!target.contextId) {
        revealTarget(target)
        return
      }
      void window.api.researchWorkspaces
        .getQuestionContext({ projectId: target.projectId, id: target.contextId })
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
  }, [research?.projectId, t])
}
