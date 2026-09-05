/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport
} from '@/components/ui/message-scroller'
import {
  usePreviewWorkbenchStore,
  createSessionReviewerPreviewItem,
  createSessionSubagentsPreviewItem
} from '@/stores/preview-workbench-store'
import {
  selectProjectSessionReviews,
  selectProjectSessionReviewLoadError,
  selectReviewRunsForMessage,
  useReviewStore
} from '@/stores/review-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useSessionStore, type ChatMessage, type ChatSession } from '@/stores/session-store'
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode
} from 'react'
import { ArrowDownIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'

import { getAgentLoadingPhase } from './agent-loading-message'
import {
  createPreviewFileItemFromArtifact,
  createPreviewFileItemFromLocal,
  createPreviewFileItemFromMention,
  createPreviewFileItemFromUpload
} from './preview-file-item'
import { createPreviewRequestScope } from './previews/preview-file-reader'
import { resolveLocalPath } from '../../../../shared/local-fs'
import { resolveProjectId } from '../../../../shared/project-scope'
import { useGrantedFoldersStore } from '@/stores/granted-folders-store'
import type { JobSummary } from '../../../../shared/compute'
import { CompletedJobCard } from '@/components/CompletedJobCard'
import { JobDetailModal } from '@/components/JobDetailModal'
import { extractJobIdFromActivity } from '@/components/job-binding-utils'
import { MessageScrollerItem } from '@/components/ui/message-scroller'
import { Button } from '@/components/ui/button'
import { ReviewerCard } from '@/components/ReviewerCard'
import { WorkspaceActivityGroup } from './WorkspaceActivityGroup'
import { WorkspaceContextCompactionActivityRow } from './WorkspaceContextCompactionActivityRow'
import { WorkspaceSessionConfigChangeRow } from './WorkspaceSessionConfigChangeRow'
import { WorkspacePlanActivityRecord } from './WorkspacePlanActivityRecord'
import { parseGeneratePlanDocument } from './generate-plan-activity-projection'
import { WorkspaceAgentLoadingRow } from './WorkspaceAgentLoadingRow'
import { EmptyConversationBanner } from './EmptyConversationBanner'
import { WorkspaceAssistantTurnCompletion, WorkspaceMessageItem } from './WorkspaceMessageItem'
import { WorkspaceRunMarks } from './WorkspaceRunMarks'
import type { ArtifactMentionPart, EditAnnotationTarget } from './WorkspaceMessageItem'
import { useWorkspaceArtifactVisibility, type MessageArtifact } from './WorkspaceArtifactVisibility'
import { useWorkspaceMessageEditState } from './workspace-message-edit-state-context'
import {
  createConversationItems,
  hidesBehindPresentationBarrier
} from './workspace-conversation-items'
import type { ActivityExpansionOverrides } from './workspace-tool-activity-groups'
import { createWorkspaceConversationTimeline } from './workspace-conversation-timeline'
import { useSessionJobStore } from '@/stores/session-job-store'
import { useSessionJobHydration } from '@/lib/compute/useSessionJobHydration'
import type { GoToTranscriptIntent, ReviewWithChecks } from '../../../../shared/reviewer'
import type { SendEditedMessage } from './workspace-edited-message'
import type {
  Annotation,
  AnnotationValidationError,
  SessionTextAnnotationItemType,
  TextAnnotation
} from '../../../../shared/annotations'
import type {
  HandoffLifecycleEventSource,
  HandoffRetryRequest
} from '../../../../shared/handoff-lifecycle'
import type { PendingElicitationRequest } from '../../../../shared/acp'
import { isHumanUserMessage } from '../../../../shared/session-persistence'
import { HandoffLifecycleStatus } from './HandoffLifecycleStatus'
import { useHandoffLifecycleEvents } from './useHandoffLifecycleEvents'
import type { NotebookSessionReference } from '../../../../shared/notebook'
import { useNotebookRunsById } from './use-notebook-runs-by-id'
import { WorkspaceElicitationCard } from './WorkspaceElicitationCard'
import { WorkspaceSubagentMessageRow } from './WorkspaceSubagentMessageRow'
import { getNotebookRunIdFromActivity } from './workspace-tool-activity-details'
import { setWorkspacePresentationRevealing } from './workspace-presentation-revealing'
import { useTranscriptWindow } from './use-transcript-window'
import { subscribeAnnotationRevealPreparation } from './annotations/annotation-reveal'
import type { AnnotationPort } from './annotations/annotation-port'

type WorkspaceMessageScrollerProps = {
  activeSession: ChatSession | undefined
  credentialPending?: boolean
  visiblePermissionPending?: boolean
  isResumingSession?: boolean
  notebookReference?: NotebookSessionReference
  onSendEditedMessage: SendEditedMessage
  optimisticMessage?: ChatMessage
  annotations?: readonly Annotation[]
  onAddAnnotation?: (annotation: TextAnnotation) => AnnotationValidationError | undefined
  onUpdateAnnotationNote?: (id: string, note: string) => AnnotationValidationError | undefined
  onAnnotationError?: (error: AnnotationValidationError) => void
  canBranchInNewSession?: boolean
  onBranchInNewSession?: (messageId: string) => void
  trailingContent?: ReactNode
  pendingElicitations?: PendingElicitationRequest[]
  // Events are read-only projections; retry sends an intent that main validates against its state.
  handoffLifecycleSource?: HandoffLifecycleEventSource
  onRetryHandoff?: (request: HandoffRetryRequest) => Promise<void>
  // Opt-in (main panel only): report smooth-streaming reveal activity so the workspace
  // message queue can hold queued sends until the transcript finishes presenting.
  reportPresentationRevealing?: boolean
}

type TerminalAnnouncement = {
  messageId: string
  status: 'complete' | 'error'
}

type TerminalMessageSnapshot = {
  scopeId: string | undefined
  statuses: Map<string, ChatMessage['status']>
}

type SessionScopedActivityGroupState = {
  sessionId: string | undefined
  groupIds: Set<string>
}

type SessionScopedActivityExpansionState = {
  sessionId: string | undefined
  overrides: ActivityExpansionOverrides
}

type SessionItemRevealRequest = Readonly<{
  requestId: number
  itemId: string
  itemType: SessionTextAnnotationItemType
  sectionId?: string
}>

type SessionScopedNearViewportNotebookRunState = {
  sessionId: string | undefined
  runIds: Set<string>
}

const EMPTY_ACTIVITY_EXPANSION_OVERRIDES: ActivityExpansionOverrides = {}
const EMPTY_NOTEBOOK_RUN_IDS: ReadonlySet<string> = new Set()

// Extra hold after the paced reveal drains, so a queued message dispatches into a settled
// transcript instead of the same moment as the final reveal frame.
const PRESENTATION_SETTLE_MS = 500

type SessionScopedMessagePresentationState = {
  scopeId: string | undefined
  messageIds: Set<string>
}

type VisibleMessageSnapshot = {
  scopeId: string | undefined
  messageIds: Set<string>
}

const VisibleMessageSnapshotCommit = ({
  scopeId,
  messageIdsKey,
  onCommit
}: {
  scopeId: string | undefined
  messageIdsKey: string
  onCommit: (scopeId: string | undefined, messageIds: Set<string>) => void
}): null => {
  useLayoutEffect(() => {
    onCommit(scopeId, new Set(JSON.parse(messageIdsKey)))
  }, [messageIdsKey, onCommit, scopeId])
  return null
}

type MessageUploadAttachment = NonNullable<ChatSession['messages'][number]['uploads']>[number]
type ConversationMessageNode = NonNullable<ChatSession['conversationGraph']>['messages'][number]
const SCROLL_TO_FIRST_MESSAGE_MIN_USER_TURNS = 2
const SCROLL_TO_FIRST_MESSAGE_MIN_HEIGHT_VIEWPORTS = 2
const SCROLL_TO_FIRST_MESSAGE_MIN_PROGRESS = 0.1
const SCROLL_TO_FIRST_MESSAGE_MIN_DISTANCE_VIEWPORTS = 1
const SCROLL_TO_FIRST_MESSAGE_IDLE_TIMEOUT_MS = 3000
// How long a "no longer available" mention notice stays visible before auto-dismissing.
const MENTION_NOTICE_TIMEOUT_MS = 3000

const structurallyMatches = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

// The Plan tool call can outlive the durable artifact it created while waiting for review. Attribute
// that artifact to exactly one generation call so a timeout/restart cannot rewrite success as failure,
// while a later retry from the same Conversation Turn remains independent.
const findDurablePlanOwnerActivityId = (
  session: ChatSession | undefined,
  conversationItems: ReturnType<typeof createConversationItems>
): string | undefined => {
  const projection = session?.activePlanProjection
  const plan = projection ?? session?.runtimeContext?.plan
  const originatingPromptMessageId = plan?.originatingPromptMessageId
  if (!session || !plan || !originatingPromptMessageId) return undefined

  const projectedDocument =
    projection?.artifactId === plan.artifactId &&
    projection.artifactVersionId === plan.artifactVersionId &&
    projection.artifactChecksum === plan.artifactChecksum
      ? projection.document
      : undefined
  const materializedAt = plan.materializedAt ?? projection?.materializedAt
  if (materializedAt === undefined && !projectedDocument) return undefined

  const planActivities = conversationItems.flatMap((item) =>
    item.type === 'plan-activity' ? [item.activity] : []
  )
  const candidates = planActivities.filter((activity) => {
    if (
      activity.promptMessageId !== originatingPromptMessageId ||
      (materializedAt !== undefined && activity.createdAt > materializedAt)
    ) {
      return false
    }
    const document = parseGeneratePlanDocument(activity.rawInput)
    return Boolean(
      document && (!projectedDocument || structurallyMatches(document, projectedDocument))
    )
  })

  const ordered = candidates.sort(
    (left, right) =>
      left.createdAt - right.createdAt ||
      left.sortIndex - right.sortIndex ||
      left.id.localeCompare(right.id)
  )
  // New Plans persist an exact materialization boundary. Legacy projections without it remain
  // fail-closed unless a single matching call makes ownership unambiguous.
  if (materializedAt === undefined) return ordered.length === 1 ? ordered[0]?.id : undefined
  return ordered.at(-1)?.id
}

// Sends an app-managed generated file to the preview workbench instead of opening it locally.
const previewArtifact = (
  artifact: MessageArtifact,
  sessionId: string,
  projectId?: string
): void => {
  const previewItem = createPreviewFileItemFromArtifact(
    artifact,
    artifact.resolvedSessionId ?? sessionId,
    artifact.resolvedProjectId ?? projectId
  )

  // Generated files keep their artifact id so repeated clicks refresh the existing preview tab.
  if (previewItem) usePreviewWorkbenchStore.getState().upsertAndActivateItem(previewItem)
}

// Opens an artifact-backed Markdown image in the existing transient file-preview dialog.
const previewArtifactModal = (
  artifact: MessageArtifact,
  sessionId: string,
  projectId?: string
): void => {
  const previewItem = createPreviewFileItemFromArtifact(
    artifact,
    artifact.resolvedSessionId ?? sessionId,
    artifact.resolvedProjectId ?? projectId
  )

  if (previewItem) usePreviewWorkbenchStore.getState().openFileDialog(previewItem)
}

// Sends an app-managed uploaded file to the preview workbench.
const previewUploadAttachment = (
  attachment: MessageUploadAttachment,
  sessionId: string,
  projectId?: string
): void => {
  // Upload ids are namespaced away from artifact ids while preserving one tab per uploaded file.
  usePreviewWorkbenchStore
    .getState()
    .upsertAndActivateItem(createPreviewFileItemFromUpload(attachment, sessionId, projectId))
}

// Opens the Session reviewer panel in the preview workbench, positioned at the finding's locator.
const openSessionReviewer = (sessionId: string, intent: GoToTranscriptIntent): void => {
  usePreviewWorkbenchStore.getState().upsertAndActivateItem(
    createSessionReviewerPreviewItem({
      sessionId,
      reviewId: intent.reviewId,
      findingId: intent.checkId ?? intent.findingId,
      locator: intent.locator
    })
  )
}

type WorkspaceMessageReviewProps = {
  projectId: string | undefined
  sessionId: string
  turnMessageId: string
  activeBranchMessageIds: ReadonlySet<string>
  onGoToTranscript: (intent: GoToTranscriptIntent) => void
  onRerun: (review: ReviewWithChecks) => Promise<boolean>
}

// Keep reviewer updates local to their card. Subscribing the transcript parent to the whole Session
// review array made every reviewer push rebuild every rich Markdown message in large conversations.
const WorkspaceMessageReview = ({
  projectId,
  sessionId,
  turnMessageId,
  activeBranchMessageIds,
  onGoToTranscript,
  onRerun
}: WorkspaceMessageReviewProps): React.JSX.Element | null => {
  const reviewIds = useReviewStore(
    useShallow((state) =>
      selectReviewRunsForMessage(
        state.reviewsBySession,
        projectId,
        sessionId,
        turnMessageId,
        activeBranchMessageIds
      ).map((review) => review.id)
    )
  )

  if (reviewIds.length === 0) return null
  return (
    <MessageScrollerItem messageId={`review-${turnMessageId}`} className="min-w-0">
      <div className="px-4 pb-1 md:px-6" data-review-anchor-message-id={turnMessageId}>
        <div className="mx-auto flex w-full max-w-[56rem] flex-col gap-2">
          {reviewIds.map((reviewId) => (
            <WorkspaceReviewCard
              key={reviewId}
              projectId={projectId}
              sessionId={sessionId}
              reviewId={reviewId}
              onGoToTranscript={onGoToTranscript}
              onRerun={onRerun}
            />
          ))}
        </div>
      </div>
    </MessageScrollerItem>
  )
}

const WorkspaceReviewCard = ({
  projectId,
  sessionId,
  reviewId,
  onGoToTranscript,
  onRerun
}: Omit<WorkspaceMessageReviewProps, 'turnMessageId' | 'activeBranchMessageIds'> & {
  reviewId: string
}): React.JSX.Element | null => {
  const review = useReviewStore((state) =>
    selectProjectSessionReviews(state.reviewsBySession, projectId, sessionId).find(
      (candidate) => candidate.id === reviewId
    )
  )
  if (!review) return null
  return <ReviewerCard review={review} onGoToTranscript={onGoToTranscript} onRerun={onRerun} />
}

type EditableWorkspaceMessageItemProps = Omit<
  ComponentProps<typeof WorkspaceMessageItem>,
  'canEditMessage'
>

// Only user-message edit controls subscribe to review-sensitive edit availability. Agent rows remain
// outside this context subscription, so a reviewer lifecycle transition cannot rebuild rich output.
const EditableWorkspaceMessageItem = (
  props: EditableWorkspaceMessageItemProps
): React.JSX.Element => {
  const canEditMessage = useWorkspaceMessageEditState()
  return <WorkspaceMessageItem {...props} canEditMessage={canEditMessage} />
}

// Owns transcript scrolling and session-scoped expansion state for activity groups.
const WorkspaceMessageScrollerImpl = ({
  activeSession,
  credentialPending = false,
  visiblePermissionPending = false,
  isResumingSession = false,
  notebookReference,
  onSendEditedMessage,
  annotations = [],
  onAddAnnotation,
  onUpdateAnnotationNote,
  onAnnotationError,
  optimisticMessage,
  canBranchInNewSession = false,
  onBranchInNewSession,
  trailingContent,
  pendingElicitations = [],
  handoffLifecycleSource,
  onRetryHandoff,
  reportPresentationRevealing = false
}: WorkspaceMessageScrollerProps): React.JSX.Element => {
  const { t } = useTranslation()
  const editAnnotationTargetRef = useRef<EditAnnotationTarget | undefined>(undefined)
  const handleEditAnnotationTargetChange = useCallback(
    (messageId: string, target: EditAnnotationTarget | undefined): void => {
      if (target || editAnnotationTargetRef.current?.messageId === messageId) {
        editAnnotationTargetRef.current = target
      }
    },
    []
  )
  const handleAddTextAnnotation = useCallback(
    (annotation: TextAnnotation): AnnotationValidationError | undefined =>
      editAnnotationTargetRef.current?.add(annotation) ?? onAddAnnotation?.(annotation),
    [onAddAnnotation]
  )
  const currentSessionId = activeSession?.id
  const activeTextAnnotations = annotations.filter(
    (annotation): annotation is TextAnnotation => annotation.kind === 'text'
  )
  const annotationPortFor = (
    activeAnnotations: readonly TextAnnotation[]
  ): AnnotationPort | undefined =>
    currentSessionId && onAddAnnotation && onAnnotationError
      ? {
          sessionId: currentSessionId,
          activeAnnotations,
          onAdd: handleAddTextAnnotation,
          onUpdateNote: onUpdateAnnotationNote,
          onError: onAnnotationError
        }
      : undefined
  const currentProjectId = activeSession?.projectId
  const statusAllowsScrollToFirstMessage = Boolean(
    activeSession &&
    activeSession.status !== 'running' &&
    !activeSession.status.startsWith('waiting-') &&
    !activeSession.compacting
  )
  const messageScrollerViewportRef = useRef<HTMLDivElement | null>(null)
  const [messageScrollerViewport, setMessageScrollerViewport] = useState<HTMLDivElement | null>(
    null
  )
  const messageScrollerContentRef = useRef<HTMLDivElement | null>(null)
  const scrollToFirstMessageButtonRef = useRef<HTMLButtonElement | null>(null)
  const previousMessageScrollerScrollTopRef = useRef(0)
  const scrollToFirstMessageHideTimeoutRef = useRef<number | undefined>(undefined)
  const [scrollThresholdAllowsFirstMessage, setScrollThresholdAllowsFirstMessage] = useState(false)
  const handleMessageScrollerViewportRef = useCallback((node: HTMLDivElement | null): void => {
    messageScrollerViewportRef.current = node
    setMessageScrollerViewport(node)
  }, [])
  const conversationGraph = activeSession?.conversationGraph
  const activeConversationFrame = conversationGraph?.frames.find(
    (frame) => frame.id === conversationGraph.activeFrameId
  )
  const currentPresentationScopeId = currentSessionId
    ? JSON.stringify([currentSessionId, activeConversationFrame?.activeBranchId ?? 'legacy'])
    : undefined
  const artifactVisibility = useWorkspaceArtifactVisibility(activeSession)
  const handoffEvents = useHandoffLifecycleEvents(handoffLifecycleSource, currentSessionId)
  // The whole-window find bar is an Electron overlay owned by main. Announce that this transcript is
  // searchable, and expand a bounded transcript before native find scans the main renderer document.
  useEffect(() => {
    const stop = window.api?.window?.announceWindowFindReady?.()
    return () => stop?.()
  }, [])
  const loadReviewsForSession = useReviewStore((state) => state.loadReviewsForSession)
  const reviewLoadError = useReviewStore((state) =>
    selectProjectSessionReviewLoadError(
      state.loadErrorsBySession,
      currentProjectId,
      currentSessionId
    )
  )

  // Job store for binding and CompletedJobCard rendering
  const jobsById = useSessionJobStore((s) => s.jobsById)
  const jobHydration = useSessionJobHydration(currentSessionId)

  // Job detail modal state
  const [modalOpen, setModalOpen] = useState(false)
  const [modalJob, setModalJob] = useState<JobSummary | undefined>(undefined)

  const handleOpenJobDetail = useCallback((job: JobSummary) => {
    setModalJob(job)
    setModalOpen(true)
  }, [])

  const handleCloseModal = useCallback(() => {
    setModalOpen(false)
  }, [])

  // Load persisted reviews whenever the active session changes.
  useEffect(() => {
    if (currentSessionId) {
      void loadReviewsForSession(currentSessionId, currentProjectId)
    }
  }, [currentProjectId, currentSessionId, loadReviewsForSession])

  // Reload (which recomputes staleness against current artifact bytes) when the window regains focus.
  // An artifact edited outside the app while this session stays open would otherwise keep showing its
  // review as current until the user switched sessions away and back; a focus return is the natural
  // moment an out-of-app edit could have happened.
  useEffect(() => {
    if (!currentSessionId) return

    const onFocus = (): void => {
      void loadReviewsForSession(currentSessionId, currentProjectId)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [currentProjectId, currentSessionId, loadReviewsForSession])

  // Group expansion is keyed by session so switching conversations never reuses stale UI state.
  const [collapsedActivityGroupState, setCollapsedActivityGroupState] =
    useState<SessionScopedActivityGroupState>(() => ({
      sessionId: undefined,
      groupIds: new Set()
    }))
  // Individual detail rows default collapsed; overrides remember only explicit user toggles.
  const [activityExpansionOverrideState, setActivityExpansionOverrideState] =
    useState<SessionScopedActivityExpansionState>(() => ({
      sessionId: undefined,
      overrides: {}
    }))
  const [sessionItemRevealRequest, setSessionItemRevealRequest] =
    useState<SessionItemRevealRequest>()
  const annotationRevealRequestIdRef = useRef(0)
  const [messagePresentationState, setMessagePresentationState] =
    useState<SessionScopedMessagePresentationState>(() => ({
      scopeId: undefined,
      messageIds: new Set()
    }))
  const collapsedActivityGroups =
    collapsedActivityGroupState.sessionId === currentSessionId
      ? collapsedActivityGroupState.groupIds
      : new Set<string>()
  const activityExpansionOverrides =
    activityExpansionOverrideState.sessionId === currentSessionId
      ? activityExpansionOverrideState.overrides
      : EMPTY_ACTIVITY_EXPANSION_OVERRIDES
  const [nearViewportNotebookRunState, setNearViewportNotebookRunState] =
    useState<SessionScopedNearViewportNotebookRunState>(() => ({
      sessionId: undefined,
      runIds: new Set()
    }))
  const nearViewportNotebookRunIds =
    nearViewportNotebookRunState.sessionId === currentSessionId
      ? nearViewportNotebookRunState.runIds
      : EMPTY_NOTEBOOK_RUN_IDS
  const rawConversationItems = useMemo(
    () => createConversationItems(activeSession, handoffEvents),
    [activeSession, handoffEvents]
  )
  const conversationItems = useMemo(
    () => createWorkspaceConversationTimeline(activeSession, handoffEvents),
    [activeSession, handoffEvents]
  )
  const notebookRunIdByActivityId = useMemo(
    () =>
      new Map(
        conversationItems.flatMap((item) => {
          const activities =
            item.type === 'activity-group'
              ? item.activities
              : item.type === 'activity'
                ? [item.activity]
                : []
          return activities.flatMap((activity) => {
            const runId = getNotebookRunIdFromActivity(activity)
            return runId ? [[activity.id, runId] as const] : []
          })
        })
      ),
    [conversationItems]
  )
  const requestedNotebookRunIds = useMemo(() => {
    const expandedRunIds = Object.entries(activityExpansionOverrides).flatMap(
      ([activityId, expanded]) => {
        const runId = expanded ? notebookRunIdByActivityId.get(activityId) : undefined
        return runId ? [runId] : []
      }
    )
    return [...new Set([...expandedRunIds, ...nearViewportNotebookRunIds])]
  }, [activityExpansionOverrides, nearViewportNotebookRunIds, notebookRunIdByActivityId])
  const notebookRunsById = useNotebookRunsById(notebookReference, requestedNotebookRunIds)
  const handleNotebookRunNearViewport = useCallback(
    (runId: string, isNearViewport: boolean): void => {
      if (!currentSessionId) return
      setNearViewportNotebookRunState((current) => {
        const runIds =
          current.sessionId === currentSessionId ? new Set(current.runIds) : new Set<string>()
        const hadRunId = runIds.has(runId)

        if (isNearViewport) {
          runIds.add(runId)
        } else {
          runIds.delete(runId)
        }

        if (current.sessionId === currentSessionId && hadRunId === runIds.has(runId)) return current
        return { sessionId: currentSessionId, runIds }
      })
    },
    [currentSessionId]
  )
  const [visibleMessageSnapshot, setVisibleMessageSnapshot] = useState<VisibleMessageSnapshot>(
    () => ({ scopeId: undefined, messageIds: new Set() })
  )
  const presentationScopeRemainedVisible =
    visibleMessageSnapshot.scopeId === currentPresentationScopeId
  const presentingMessageIds =
    messagePresentationState.scopeId === currentPresentationScopeId
      ? messagePresentationState.messageIds
      : new Set<string>()
  const presentationRevealing = presentingMessageIds.size > 0
  // Let the workspace message queue hold queued sends until this transcript's reveal finishes,
  // plus a short settle delay so the dispatched message's scroll anchor lands after the final
  // frame. Session switch/unmount clears immediately so a stale flag can't deadlock a queue.
  useEffect(() => {
    if (!reportPresentationRevealing || !currentSessionId) return
    if (presentationRevealing) {
      setWorkspacePresentationRevealing(currentSessionId, true)
      return
    }
    const settleTimer = setTimeout(
      () => setWorkspacePresentationRevealing(currentSessionId, false),
      PRESENTATION_SETTLE_MS
    )
    return () => clearTimeout(settleTimer)
  }, [reportPresentationRevealing, currentSessionId, presentationRevealing])
  useEffect(() => {
    if (!reportPresentationRevealing || !currentSessionId) return
    return () => setWorkspacePresentationRevealing(currentSessionId, false)
  }, [reportPresentationRevealing, currentSessionId])
  const presentationBarrierIndex = conversationItems.findIndex(
    (item) => item.type === 'message' && presentingMessageIds.has(item.message.id)
  )
  const presentedConversationItems =
    presentationBarrierIndex >= 0
      ? conversationItems.slice(0, presentationBarrierIndex + 1)
      : conversationItems
  const transcriptWindow = useTranscriptWindow(
    currentPresentationScopeId,
    conversationItems,
    presentationBarrierIndex,
    messageScrollerViewportRef
  )
  const revealTranscriptItem = transcriptWindow.revealMessage
  useEffect(
    () =>
      subscribeAnnotationRevealPreparation((annotation) => {
        if (annotation.kind !== 'text') return
        const source = annotation.source
        if (
          (source.kind !== 'agent-message' && source.kind !== 'session-item') ||
          source.sessionId !== currentSessionId
        ) {
          return
        }

        const targetIndex = conversationItems.findIndex((item) => {
          if (source.kind === 'agent-message') {
            return item.type === 'message' && item.message.id === source.messageId
          }
          if (source.itemType === 'tool-activity') {
            return (
              item.type === 'activity-group' &&
              item.activities.some((activity) => activity.id === source.itemId)
            )
          }
          if (source.itemType === 'plan') {
            return item.type === 'plan-activity' && item.activity.id === source.itemId
          }
          if (source.itemType === 'elicitation') {
            return item.type === 'activity' && item.activity.id === source.itemId
          }
          if (source.itemType === 'subagent-message') {
            return item.type === 'subagent-message' && item.message.messageId === source.itemId
          }
          return false
        })
        if (
          targetIndex < 0 ||
          (presentationBarrierIndex >= 0 && targetIndex > presentationBarrierIndex)
        ) {
          return
        }

        const target = conversationItems[targetIndex]!
        revealTranscriptItem(target.id)
        if (source.kind !== 'session-item') return

        const request = {
          requestId: ++annotationRevealRequestIdRef.current,
          itemId: source.itemId,
          itemType: source.itemType,
          ...(source.sectionId ? { sectionId: source.sectionId } : {})
        }
        setSessionItemRevealRequest(request)
        if (source.itemType !== 'tool-activity' || target.type !== 'activity-group') return

        setCollapsedActivityGroupState((current) => {
          const groupIds =
            current.sessionId === currentSessionId ? new Set(current.groupIds) : new Set<string>()
          groupIds.delete(target.id)
          return { sessionId: currentSessionId, groupIds }
        })
        setActivityExpansionOverrideState((current) => ({
          sessionId: currentSessionId,
          overrides: {
            ...(current.sessionId === currentSessionId ? current.overrides : {}),
            [source.itemId]: true
          }
        }))
      }),
    [conversationItems, currentSessionId, presentationBarrierIndex, revealTranscriptItem]
  )
  const revealFullTranscript = transcriptWindow.revealAll
  const [windowFindOpen, setWindowFindOpen] = useState(false)
  const windowFindAcknowledgedScopeRef = useRef<{ scopeId: string | undefined } | undefined>(
    undefined
  )
  const showWindowFind = useCallback((): void => {
    windowFindAcknowledgedScopeRef.current = undefined
    setWindowFindOpen(true)
    revealFullTranscript()
  }, [revealFullTranscript])
  useEffect(() => {
    return window.api?.window?.onShowWindowFind?.(showWindowFind)
  }, [showWindowFind])
  const restoreTranscriptWindow = transcriptWindow.restoreWindow
  const hideWindowFind = useCallback((): void => {
    windowFindAcknowledgedScopeRef.current = undefined
    setWindowFindOpen(false)
    restoreTranscriptWindow()
  }, [restoreTranscriptWindow])
  useEffect(() => {
    return window.api?.window?.onHideWindowFind?.(hideWindowFind)
  }, [hideWindowFind])
  useLayoutEffect(() => {
    if (windowFindOpen) revealFullTranscript()
  }, [currentPresentationScopeId, revealFullTranscript, windowFindOpen])
  useLayoutEffect(() => {
    if (
      !windowFindOpen ||
      presentationBarrierIndex >= 0 ||
      transcriptWindow.entries.length !== conversationItems.length
    ) {
      return
    }
    const acknowledgedScope = windowFindAcknowledgedScopeRef.current
    if (acknowledgedScope && acknowledgedScope.scopeId === currentPresentationScopeId) return
    windowFindAcknowledgedScopeRef.current = { scopeId: currentPresentationScopeId }
    window.api?.window?.announceWindowFindContentReady?.()
  }, [
    conversationItems.length,
    currentPresentationScopeId,
    presentationBarrierIndex,
    transcriptWindow.entries.length,
    windowFindOpen
  ])
  // Brand-new conversation (nothing presented, no resume in flight): invite the first prompt with
  // a centered placeholder banner over the empty transcript area.
  const showEmptyConversationBanner =
    presentedConversationItems.length === 0 && !optimisticMessage && !isResumingSession
  const visibleMessageIds = presentedConversationItems.flatMap((item) =>
    item.type === 'message' ? [item.message.id] : []
  )
  const visibleMessageIdsKey = JSON.stringify(visibleMessageIds)
  const activeBranchMessageIds = useMemo(
    () =>
      new Set(
        conversationItems.flatMap((item) => (item.type === 'message' ? [item.message.id] : []))
      ),
    [conversationItems]
  )
  const responseByPromptMessageId = useMemo(
    () =>
      new Map(
        conversationItems.flatMap((item) =>
          item.type === 'message' &&
          item.message.role === 'agent' &&
          item.message.responseToMessageId
            ? [[item.message.responseToMessageId, item.message] as const]
            : []
        )
      ),
    [conversationItems]
  )
  const userTurnCount = presentedConversationItems.filter(
    (item) => item.type === 'message' && item.message.role === 'user'
  ).length
  const updateScrollToFirstMessageEligibility = useCallback((): boolean => {
    const viewport = messageScrollerViewportRef.current
    if (!viewport || viewport.clientHeight <= 0) {
      setScrollThresholdAllowsFirstMessage(false)
      return false
    }

    const maximumScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    const hasEnoughConversation =
      userTurnCount >= SCROLL_TO_FIRST_MESSAGE_MIN_USER_TURNS ||
      viewport.scrollHeight >= viewport.clientHeight * SCROLL_TO_FIRST_MESSAGE_MIN_HEIGHT_VIEWPORTS
    const hasScrolledFarEnough =
      maximumScrollTop > 0 &&
      (viewport.scrollTop >= maximumScrollTop * SCROLL_TO_FIRST_MESSAGE_MIN_PROGRESS ||
        viewport.scrollTop >=
          viewport.clientHeight * SCROLL_TO_FIRST_MESSAGE_MIN_DISTANCE_VIEWPORTS)
    const eligible = hasEnoughConversation && hasScrolledFarEnough
    setScrollThresholdAllowsFirstMessage(eligible)
    return eligible
  }, [userTurnCount])
  const clearScrollToFirstMessageHideTimeout = useCallback((): void => {
    if (scrollToFirstMessageHideTimeoutRef.current !== undefined) {
      window.clearTimeout(scrollToFirstMessageHideTimeoutRef.current)
      scrollToFirstMessageHideTimeoutRef.current = undefined
    }
  }, [])
  const setScrollToFirstMessageRevealed = useCallback((revealed: boolean): void => {
    const button = scrollToFirstMessageButtonRef.current
    if (!button) return
    button.dataset.revealed = String(revealed)
    button.setAttribute('aria-hidden', String(!revealed))
    button.tabIndex = revealed ? 0 : -1
  }, [])
  const hideScrollToFirstMessage = useCallback((): void => {
    clearScrollToFirstMessageHideTimeout()
    setScrollToFirstMessageRevealed(false)
  }, [clearScrollToFirstMessageHideTimeout, setScrollToFirstMessageRevealed])
  const revealScrollToFirstMessage = useCallback((): void => {
    clearScrollToFirstMessageHideTimeout()
    setScrollToFirstMessageRevealed(true)
    scrollToFirstMessageHideTimeoutRef.current = window.setTimeout(() => {
      scrollToFirstMessageHideTimeoutRef.current = undefined
      setScrollToFirstMessageRevealed(false)
    }, SCROLL_TO_FIRST_MESSAGE_IDLE_TIMEOUT_MS)
  }, [clearScrollToFirstMessageHideTimeout, setScrollToFirstMessageRevealed])
  const handleMessageScrollerScroll = (): void => {
    const viewport = messageScrollerViewportRef.current
    if (!viewport) return

    const previousScrollTop = previousMessageScrollerScrollTopRef.current
    previousMessageScrollerScrollTopRef.current = viewport.scrollTop
    const eligible = updateScrollToFirstMessageEligibility()
    transcriptWindow.expandAtScrollEdge(previousScrollTop)
    if (viewport.scrollTop < previousScrollTop && eligible) revealScrollToFirstMessage()
    else if (viewport.scrollTop > previousScrollTop) hideScrollToFirstMessage()
  }
  useLayoutEffect(() => {
    updateScrollToFirstMessageEligibility()
  }, [currentSessionId, updateScrollToFirstMessageEligibility, visibleMessageIdsKey])
  useLayoutEffect(() => {
    previousMessageScrollerScrollTopRef.current = messageScrollerViewportRef.current?.scrollTop ?? 0
    hideScrollToFirstMessage()
  }, [currentSessionId, hideScrollToFirstMessage])
  useEffect(() => clearScrollToFirstMessageHideTimeout, [clearScrollToFirstMessageHideTimeout])
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    let eligibilityFrame = 0
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(eligibilityFrame)
      eligibilityFrame = window.requestAnimationFrame(updateScrollToFirstMessageEligibility)
    })
    const viewport = messageScrollerViewportRef.current
    const content = messageScrollerContentRef.current
    if (viewport) observer.observe(viewport)
    if (content) observer.observe(content)
    return () => {
      window.cancelAnimationFrame(eligibilityFrame)
      observer.disconnect()
    }
  }, [currentSessionId, updateScrollToFirstMessageEligibility])
  const showScrollToFirstMessage =
    statusAllowsScrollToFirstMessage && scrollThresholdAllowsFirstMessage
  const handleVisibleMessageSnapshotCommit = useCallback(
    (scopeId: string | undefined, messageIds: Set<string>): void => {
      setVisibleMessageSnapshot({ scopeId, messageIds })
    },
    []
  )
  const handleMessagePresentationChange = useCallback(
    (messageId: string, presenting: boolean): void => {
      setMessagePresentationState((currentState) => {
        const currentMessageIds =
          currentState.scopeId === currentPresentationScopeId
            ? currentState.messageIds
            : new Set<string>()
        if (currentMessageIds.has(messageId) === presenting) return currentState

        const nextMessageIds = new Set(currentMessageIds)
        if (presenting) nextMessageIds.add(messageId)
        else nextMessageIds.delete(messageId)
        return { scopeId: currentPresentationScopeId, messageIds: nextMessageIds }
      })
    },
    [currentPresentationScopeId]
  )
  const durablePlanOwnerActivityId = useMemo(
    () => findDurablePlanOwnerActivityId(activeSession, rawConversationItems),
    [activeSession, rawConversationItems]
  )
  // Visible and announced completion share the same turn-level timeline authority.
  const assistantFooterMessageIds = useMemo(() => {
    return new Set(
      conversationItems.flatMap((item) =>
        item.type === 'turn-completion' ? [item.message.id] : []
      )
    )
  }, [conversationItems])
  const agentLoadingPhase = getAgentLoadingPhase(activeSession, { credentialPending })
  const [terminalAnnouncement, setTerminalAnnouncement] = useState<
    TerminalAnnouncement | undefined
  >()
  const terminalMessageSnapshotRef = useRef<TerminalMessageSnapshot>({
    scopeId: undefined,
    statuses: new Map()
  })

  // Persisted terminal messages are history, not live events. Establish a fresh snapshot whenever
  // the visible session/branch changes, then announce only terminal states observed afterwards.
  useEffect(() => {
    const terminalMessages = (activeSession?.messages ?? []).filter(
      (message) => message.role === 'agent' && assistantFooterMessageIds.has(message.id)
    )
    const nextStatuses = new Map(
      terminalMessages.map((message) => [message.id, message.status] as const)
    )
    const previousSnapshot = terminalMessageSnapshotRef.current
    let nextAnnouncement: TerminalAnnouncement | undefined

    if (currentPresentationScopeId && previousSnapshot.scopeId === currentPresentationScopeId) {
      for (const message of terminalMessages) {
        if (
          (message.status === 'complete' || message.status === 'error') &&
          previousSnapshot.statuses.get(message.id) !== message.status
        ) {
          nextAnnouncement = { messageId: message.id, status: message.status }
        }
      }
    }

    terminalMessageSnapshotRef.current = {
      scopeId: currentPresentationScopeId,
      statuses: nextStatuses
    }
    if (previousSnapshot.scopeId !== currentPresentationScopeId) {
      setTerminalAnnouncement(undefined)
    } else if (nextAnnouncement) {
      setTerminalAnnouncement(nextAnnouncement)
    }
  }, [activeSession?.messages, assistantFooterMessageIds, currentPresentationScopeId])

  // Legacy sessions synthesize one runtime identity from session-level fields; hoist it so a
  // per-chunk transcript rebuild keeps the same reference and memoized message items can bail out.
  const legacyAgentBackendId = activeSession?.agentBackendId
  const legacyAgentModel = activeSession?.agentModel
  const legacyRuntimeIdentity = useMemo(
    () =>
      legacyAgentBackendId || legacyAgentModel
        ? { backendId: legacyAgentBackendId, model: legacyAgentModel }
        : undefined,
    [legacyAgentBackendId, legacyAgentModel]
  )
  const { conversationMessageById, runtimeSegmentById, revisionsByRootMessageId } = useMemo(() => {
    const messageById = new Map(conversationGraph?.messages.map((message) => [message.id, message]))
    const segmentById = new Map(
      conversationGraph?.runtimeSegments.map((segment) => [segment.id, segment])
    )
    const revisionsByRoot = new Map<string, ConversationMessageNode[]>()
    for (const message of conversationGraph?.messages ?? []) {
      if (message.role !== 'user' || !message.revisionRootMessageId) continue
      const revisions = revisionsByRoot.get(message.revisionRootMessageId) ?? []
      revisions.push(message)
      revisionsByRoot.set(message.revisionRootMessageId, revisions)
    }
    for (const revisions of revisionsByRoot.values()) {
      revisions.sort(
        (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)
      )
    }
    return {
      conversationMessageById: messageById,
      runtimeSegmentById: segmentById,
      revisionsByRootMessageId: revisionsByRoot
    }
  }, [conversationGraph])
  const messageCreatedAtById = useMemo(
    () => new Map(activeSession?.messages.map((message) => [message.id, message.createdAt]) ?? []),
    [activeSession?.messages]
  )

  // Counts the user turns after each message; the destructive-resend warning keys off turns, not
  // raw message count, so a single follow-up turn stays warning-free.
  const subsequentTurnCountByMessageId = useMemo(() => {
    const counts = new Map<string, number>()
    let subsequentTurns = 0
    for (let index = (activeSession?.messages.length ?? 0) - 1; index >= 0; index -= 1) {
      const message = activeSession?.messages[index]
      if (!message) continue
      counts.set(message.id, subsequentTurns)
      if (message.role === 'user') subsequentTurns += 1
    }
    return counts
  }, [activeSession?.messages])

  // Build a map from job_id → JobSummary for all session jobs (used in binding)
  const sessionJobs = useMemo((): JobSummary[] => {
    if (!currentSessionId) return []
    return Array.from(jobsById.values()).filter((j) => j.session_id === currentSessionId)
  }, [jobsById, currentSessionId])

  // Build a map from activity_id → JobSummary for quick lookup in WorkspaceActivityGroup
  // Also track which job_ids are bound to activities so we know which are unbound (CompletedJobCard)
  const { jobsByActivityId, boundJobIds } = useMemo(() => {
    const byActivityId = new Map<string, JobSummary>()
    const bound = new Set<string>()
    const jobsByJobId = new Map(sessionJobs.map((job) => [job.job_id, job]))

    for (const activity of activeSession?.activities ?? []) {
      const jobId = extractJobIdFromActivity(activity)
      if (!jobId) continue
      const job = jobsByJobId.get(jobId)
      if (!job) continue
      byActivityId.set(jobId, job)
      bound.add(jobId)
    }

    return { jobsByActivityId: byActivityId, boundJobIds: bound }
  }, [sessionJobs, activeSession?.activities])

  // Unbound completed jobs: jobs not found in any activity rawOutput — go into timeline
  const unboundCompletedJobs = useMemo((): JobSummary[] => {
    const terminalStatuses = new Set(['success', 'failed', 'timeout', 'error'])
    return sessionJobs.filter((j) => !boundJobIds.has(j.job_id) && terminalStatuses.has(j.status))
  }, [sessionJobs, boundJobIds])

  // Assign each unbound completed job to exactly one slot in the conversation timeline so
  // it is rendered at most once.  A job is placed immediately before the first conversation
  // item whose createdAt is GREATER than the job's created_at; if no such item exists the
  // job falls into the "trailing" slot rendered after all conversation items.
  //
  // Using an index-keyed Map (item index → jobs[]) instead of per-render filter on the full
  // array is the key correctness fix: every job is consumed by a single pass and never
  // re-matched against later items.
  const { jobSlotsByItemIndex, trailingJobs } = useMemo(() => {
    const sorted = [...unboundCompletedJobs].sort((a, b) => a.created_at - b.created_at)
    const byIndex = new Map<number, JobSummary[]>()
    const trailing: JobSummary[] = []

    for (const job of sorted) {
      // Find the first conversation item strictly after this job's timestamp.
      const insertBeforeIndex = conversationItems.findIndex(
        (item) => item.createdAt > job.created_at
      )
      if (insertBeforeIndex === -1) {
        // No later item — job goes in the trailing slot.
        trailing.push(job)
      } else {
        const existing = byIndex.get(insertBeforeIndex) ?? []
        existing.push(job)
        byIndex.set(insertBeforeIndex, existing)
      }
    }

    return { jobSlotsByItemIndex: byIndex, trailingJobs: trailing }
  }, [unboundCompletedJobs, conversationItems])

  // Transient "no longer available" pill shown when a mention target can't be opened.
  const [mentionNotice, setMentionNotice] = useState<string | null>(null)
  const mentionNoticeTimerRef = useRef<number | undefined>(undefined)

  // Clears any pending auto-dismiss timer so unmounting never fires setState on a dead component.
  useEffect(
    () => () => {
      if (mentionNoticeTimerRef.current !== undefined) {
        window.clearTimeout(mentionNoticeTimerRef.current)
      }
    },
    []
  )

  // Shows a transient notice and schedules its auto-dismiss, replacing any in-flight timer.
  const showMentionNotice = useCallback((message: string): void => {
    if (mentionNoticeTimerRef.current !== undefined) {
      window.clearTimeout(mentionNoticeTimerRef.current)
    }

    setMentionNotice(message)
    mentionNoticeTimerRef.current = window.setTimeout(() => {
      setMentionNotice(null)
      mentionNoticeTimerRef.current = undefined
    }, MENTION_NOTICE_TIMEOUT_MS)
  }, [])

  // Routes a generated-file click to the preview workbench, scoped to the active session.
  // These handlers stay referentially stable so memoized message items can skip re-rendering.
  const onPreviewArtifact = useCallback(
    (artifact: MessageArtifact): void => {
      if (currentSessionId) previewArtifact(artifact, currentSessionId, currentProjectId)
    },
    [currentProjectId, currentSessionId]
  )

  const onPreviewArtifactModal = useCallback(
    (artifact: MessageArtifact): void => {
      if (currentSessionId) previewArtifactModal(artifact, currentSessionId, currentProjectId)
    },
    [currentProjectId, currentSessionId]
  )

  // Routes a sent-message upload click to the preview workbench for the active session.
  const onPreviewUploadAttachment = useCallback(
    (attachment: MessageUploadAttachment): void => {
      if (currentSessionId) {
        previewUploadAttachment(attachment, currentSessionId, currentProjectId)
      }
    },
    [currentProjectId, currentSessionId]
  )

  // Opens an artifact mention in the preview panel, probing existence first so a stale link warns.
  const onPreviewMentionArtifact = useCallback(
    async (part: ArtifactMentionPart): Promise<void> => {
      if (!currentSessionId) return
      if (part.source === 'linked-folder') {
        // Linked-folder mentions resolve through the granted-roots store: the root's absolute path
        // plus the mention's relative path gives the local file to preview. A revoked root keeps
        // the "not available" notice.
        const grantedState = useGrantedFoldersStore.getState()
        const roots = grantedState.loaded
          ? grantedState.roots
          : await grantedState.refresh().catch(() => [])
        const root = roots.find((candidate) => candidate.id === part.rootId)
        if (!root) {
          showMentionNotice('Linked-folder files are not available until the folder is connected.')
          return
        }
        usePreviewWorkbenchStore.getState().upsertAndActivateItem(
          createPreviewFileItemFromLocal({
            sessionId: currentSessionId,
            path: resolveLocalPath(root.path, part.relativePath, window.api.platform),
            name: part.name
          })
        )
        return
      }

      const read =
        part.source === 'upload' ? window.api.uploads.readPreview : window.api.artifacts.readPreview

      try {
        await read({
          ...createPreviewRequestScope({
            projectId: currentProjectId,
            sessionId: currentSessionId,
            source: part.source,
            path: part.path
          }),
          path: part.path,
          maxBytes: 1,
          encoding: 'utf8'
        })
      } catch {
        showMentionNotice(`"${part.name}" is no longer available.`)
        return
      }

      usePreviewWorkbenchStore
        .getState()
        .upsertAndActivateItem(
          createPreviewFileItemFromMention(part, currentSessionId, currentProjectId)
        )
    },
    [currentProjectId, currentSessionId, showMentionNotice]
  )

  // Opens Settings on a skill mention's detail, warning instead when the skill no longer exists.
  const onOpenSkillMention = useCallback(
    async (skillId: string, name: string): Promise<void> => {
      const detail = await window.api.settings.getSkillDetail(skillId).catch(() => null)

      if (!detail) {
        showMentionNotice(`Skill "${name}" is no longer available.`)
        return
      }

      useSettingsStore.getState().openSettingsToSkill(skillId)
    },
    [showMentionNotice]
  )

  // Toggles a whole adjacent tool-activity group without affecting other sessions.
  const toggleActivityGroup = (groupId: string): void => {
    setCollapsedActivityGroupState((currentState) => {
      const currentGroupIds =
        currentState.sessionId === currentSessionId ? currentState.groupIds : new Set<string>()
      const nextGroupIds = new Set(currentGroupIds)

      if (nextGroupIds.has(groupId)) {
        nextGroupIds.delete(groupId)
      } else {
        nextGroupIds.add(groupId)
      }

      return {
        sessionId: currentSessionId,
        groupIds: nextGroupIds
      }
    })
  }

  // Records the user's explicit expansion choice for a single tool-activity detail row.
  const toggleActivityRow = (activityId: string, nextExpanded: boolean): void => {
    setActivityExpansionOverrideState((currentState) => {
      const currentOverrides =
        currentState.sessionId === currentSessionId ? currentState.overrides : {}

      return {
        sessionId: currentSessionId,
        overrides: {
          ...currentOverrides,
          [activityId]: nextExpanded
        }
      }
    })
  }

  // Opens the Session reviewer panel positioned at the finding the user clicked.
  // Only the "Go to transcript" button on a finding fires this; clicking the card itself does not.
  const handleGoToTranscript = (intent: GoToTranscriptIntent): void => {
    if (!currentSessionId) return
    openSessionReviewer(currentSessionId, intent)
  }

  // Re-runs the review for a specific (stale) turn — the actionable refresh the stale notice offers.
  // Unlike the composer's last-turn-only "Request review", this reaches any turn's review. The row is
  // grouped under review.turnMessageId (so a fix-loop review refreshes in place), but the audited
  // content is review.scope.turnMessageId — the turn whose bytes actually changed. Fire-and-forget:
  // a fresh review supersedes the stale one via reviewer:updated; concurrent runs are deduped in main.
  const handleRerunReview = async (review: ReviewWithChecks): Promise<boolean> => {
    try {
      const result = await window.api.reviewer.run({
        sessionId: review.sessionId,
        turnMessageId: review.turnMessageId,
        scopeTurnMessageId: review.scope.turnMessageId,
        projectId: review.projectId,
        mainSessionId: review.sessionId,
        // Explicit user Re-run: bypass main's auto-only per-turn idempotency so the stale/error review
        // is genuinely re-run rather than refused as already-reviewed.
        origin: 'manual'
      })
      return result?.started ?? false
    } catch {
      return false
    }
  }

  return (
    <>
      <MessageScrollerProvider
        key={activeSession?.id ?? 'empty-conversation'}
        autoScroll
        defaultScrollPosition="last-anchor"
        scrollPreviousItemPeek={64}
      >
        <MessageScroller className="relative min-h-0 flex-1 bg-bg-10">
          <WorkspaceRunMarks
            items={presentedConversationItems}
            viewport={messageScrollerViewport}
            onRevealMessage={
              presentationBarrierIndex >= 0 ? undefined : transcriptWindow.revealMessage
            }
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-bg-10 to-bg-10/0"
          />
          {showEmptyConversationBanner ? <EmptyConversationBanner /> : null}
          <MessageScrollerViewport
            ref={handleMessageScrollerViewportRef}
            aria-label={t('Conversation')}
            onScroll={handleMessageScrollerScroll}
          >
            {/* No wrapper div: message-scroller only measures/anchors Content's direct children. */}
            <MessageScrollerContent
              ref={messageScrollerContentRef}
              className="mx-auto w-full max-w-4xl gap-0 px-4 pb-[56px]"
            >
              {reviewLoadError ? (
                <MessageScrollerItem
                  messageId={`review-load-error-${currentSessionId ?? 'unknown'}`}
                  className="min-w-0"
                >
                  <div
                    role="alert"
                    className="mx-4 mb-2 flex items-center justify-between gap-3 rounded-lg bg-danger-900 px-3 py-2 text-xs text-danger-000 ring-1 ring-inset ring-danger-000/25 md:mx-6"
                  >
                    <span>{t('Could not load review history.')}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => {
                        if (currentSessionId) {
                          void loadReviewsForSession(currentSessionId, currentProjectId)
                        }
                      }}
                    >
                      {t('Retry')}
                    </Button>
                  </div>
                </MessageScrollerItem>
              ) : null}
              {jobHydration.error ? (
                <MessageScrollerItem
                  messageId={`job-load-error-${currentSessionId ?? 'unknown'}`}
                  className="min-w-0"
                >
                  <div
                    role="alert"
                    className="mx-4 mb-2 flex items-center justify-between gap-3 rounded-lg bg-danger-900 px-3 py-2 text-xs text-danger-000 ring-1 ring-inset ring-danger-000/25 md:mx-6"
                  >
                    <span>{t('Unable to load remote jobs.')}</span>
                    <Button type="button" variant="ghost" size="xs" onClick={jobHydration.retry}>
                      {t('Retry')}
                    </Button>
                  </div>
                </MessageScrollerItem>
              ) : null}
              <VisibleMessageSnapshotCommit
                scopeId={currentPresentationScopeId}
                messageIdsKey={visibleMessageIdsKey}
                onCommit={handleVisibleMessageSnapshotCommit}
              />
              {/* Messages and tool activities share one sorted transcript timeline. */}
              {transcriptWindow.entries.map(({ item, itemIndex }) => {
                // Later text messages and their config-change dividers stay behind the
                // presentation barrier. Tool, activity, and other non-message rows render
                // in real time so their running state stays visible while the reply paces
                // above them.
                if (
                  presentationBarrierIndex >= 0 &&
                  itemIndex > presentationBarrierIndex &&
                  hidesBehindPresentationBarrier(item.type)
                ) {
                  return null
                }

                if (item.type === 'message') {
                  const artifacts = artifactVisibility.artifactsForMessage(item.message)
                  // Jobs pre-assigned to this slot: each job appears in exactly one slot.
                  const jobsBeforeMessage = jobSlotsByItemIndex.get(itemIndex) ?? []
                  const messageNode = conversationMessageById.get(item.message.id)
                  const runtimeSegment = messageNode?.runtimeSegmentId
                    ? runtimeSegmentById.get(messageNode.runtimeSegmentId)
                    : undefined
                  // Legacy sessions synthesize this segment with a fallback framework. Keep only
                  // the session-level values that were actually persisted.
                  const synthesizedLegacyRuntime =
                    runtimeSegment?.id === `runtime-segment-${activeSession?.id}` &&
                    !activeSession?.agentFrameworkId
                  const runtimeIdentity = synthesizedLegacyRuntime
                    ? legacyRuntimeIdentity
                    : runtimeSegment
                  const isHumanUser = isHumanUserMessage(item.message)
                  const revisionRootMessageId = isHumanUser
                    ? messageNode?.revisionRootMessageId
                    : undefined
                  const revisions = revisionRootMessageId
                    ? (revisionsByRootMessageId.get(revisionRootMessageId) ?? [])
                    : []
                  const revisionIndex = revisions.findIndex(
                    (message) => message.id === item.message.id
                  )
                  const activateRevision = (index: number): (() => void) | undefined => {
                    const revision = revisions[index]
                    return revision && activeSession
                      ? () =>
                          useSessionStore
                            .getState()
                            .activateMessageBranch(activeSession.id, revision.introducedOnBranchId)
                      : undefined
                  }
                  const messageItemProps: EditableWorkspaceMessageItemProps = {
                    message: item.message,
                    projectId: currentProjectId,
                    onPreviewArtifact,
                    onPreviewArtifactModal,
                    onPreviewUploadAttachment,
                    onOpenSkillMention,
                    onPreviewMentionArtifact,
                    onSendEditedMessage,
                    onEditAnnotationTargetChange: isHumanUser
                      ? handleEditAnnotationTargetChange
                      : undefined,
                    annotationPort: annotationPortFor(
                      activeTextAnnotations.filter(
                        (annotation) =>
                          annotation.source.kind === 'agent-message' &&
                          annotation.source.messageId === item.message.id
                      )
                    ),
                    canBranchInNewSession,
                    onBranchInNewSession,
                    turnStartedAt: item.message.responseToMessageId
                      ? messageCreatedAtById.get(item.message.responseToMessageId)
                      : undefined,
                    runtimeIdentity,
                    showAssistantFooter: item.message.role !== 'agent',
                    subsequentTurns: subsequentTurnCountByMessageId.get(item.message.id) ?? 0,
                    revisionNavigation:
                      revisionIndex >= 0 && revisions.length > 1
                        ? {
                            index: revisionIndex,
                            total: revisions.length,
                            onPrevious: activateRevision(revisionIndex - 1),
                            onNext: activateRevision(revisionIndex + 1)
                          }
                        : undefined,
                    artifacts,
                    reviewerCorrectionState: (() => {
                      const response = responseByPromptMessageId.get(item.message.id)
                      if (response?.status === 'complete') return 'completed'
                      if (response?.status === 'error') return 'failed'

                      const runIsActive =
                        activeSession?.activeRun?.promptMessageId === item.message.id &&
                        activeSession.status !== 'idle' &&
                        activeSession.status !== 'error'
                      if (runIsActive) return response ? 'responding' : 'waiting'
                      return 'failed'
                    })()
                  }
                  if (item.message.role === 'agent') {
                    const nextConversationItem = conversationItems[itemIndex + 1]
                    // Completed activity rows remain visible too. Any following activity row means
                    // this message is not replacing the trailing loading row and needs no reserve.
                    const hasFollowingActivityRow =
                      nextConversationItem?.type === 'activity' ||
                      nextConversationItem?.type === 'activity-group'
                    messageItemProps.onPresentationChange = handleMessagePresentationChange
                    messageItemProps.presentationSourceOpen =
                      itemIndex === conversationItems.length - 1
                    messageItemProps.presentationAnimateOnMount =
                      presentationScopeRemainedVisible &&
                      !visibleMessageSnapshot.messageIds.has(item.message.id)
                    messageItemProps.reserveLoadingRowHeight =
                      !hasFollowingActivityRow &&
                      !isResumingSession &&
                      agentLoadingPhase === 'hidden'
                  }

                  return (
                    <Fragment key={item.id}>
                      {/* Unbound completed jobs that belong chronologically before this message */}
                      {jobsBeforeMessage.map((job) => (
                        <MessageScrollerItem
                          key={`completed-job-${job.job_id}`}
                          messageId={`completed-job-${job.job_id}`}
                          className="min-w-0"
                        >
                          <div className="px-4 py-1 md:px-6">
                            <div className="mx-auto w-full max-w-4xl">
                              <CompletedJobCard job={job} onOpen={handleOpenJobDetail} />
                            </div>
                          </div>
                        </MessageScrollerItem>
                      ))}
                      {/* #1124: the composite key remounts the message row when the presentation
                          scope changes; the surrounding fragment keeps sibling rows stable. */}
                      {isHumanUser ? (
                        <EditableWorkspaceMessageItem
                          key={JSON.stringify([currentPresentationScopeId, item.id])}
                          {...messageItemProps}
                        />
                      ) : (
                        <WorkspaceMessageItem
                          key={JSON.stringify([currentPresentationScopeId, item.id])}
                          {...messageItemProps}
                          canEditMessage={false}
                        />
                      )}
                      {currentSessionId &&
                      item.message.role === 'agent' &&
                      !assistantFooterMessageIds.has(item.message.id) &&
                      !presentingMessageIds.has(item.message.id) ? (
                        <WorkspaceMessageReview
                          projectId={currentProjectId}
                          sessionId={currentSessionId}
                          turnMessageId={item.message.id}
                          activeBranchMessageIds={activeBranchMessageIds}
                          onGoToTranscript={handleGoToTranscript}
                          onRerun={handleRerunReview}
                        />
                      ) : null}
                    </Fragment>
                  )
                }

                if (item.type === 'turn-completion') {
                  const messageNode = conversationMessageById.get(item.message.id)
                  const runtimeSegment = messageNode?.runtimeSegmentId
                    ? runtimeSegmentById.get(messageNode.runtimeSegmentId)
                    : undefined
                  const synthesizedLegacyRuntime =
                    runtimeSegment?.id === `runtime-segment-${activeSession?.id}` &&
                    !activeSession?.agentFrameworkId
                  const runtimeIdentity = synthesizedLegacyRuntime
                    ? legacyRuntimeIdentity
                    : runtimeSegment

                  return presentingMessageIds.has(item.message.id) ? null : (
                    <Fragment key={item.id}>
                      <MessageScrollerItem
                        messageId={item.id}
                        className="min-w-0"
                        disableContainment
                      >
                        <div className="px-4 pb-1 md:px-6">
                          <div className="mx-auto w-full max-w-[56rem]">
                            <WorkspaceAssistantTurnCompletion
                              message={item.message}
                              turnStartedAt={
                                item.message.responseToMessageId
                                  ? messageCreatedAtById.get(item.message.responseToMessageId)
                                  : undefined
                              }
                              runtimeIdentity={runtimeIdentity}
                              canBranchInNewSession={canBranchInNewSession}
                              onBranchInNewSession={onBranchInNewSession}
                            />
                          </div>
                        </div>
                      </MessageScrollerItem>
                      {currentSessionId ? (
                        <WorkspaceMessageReview
                          projectId={currentProjectId}
                          sessionId={currentSessionId}
                          turnMessageId={item.message.id}
                          activeBranchMessageIds={activeBranchMessageIds}
                          onGoToTranscript={handleGoToTranscript}
                          onRerun={handleRerunReview}
                        />
                      ) : null}
                    </Fragment>
                  )
                }

                if (item.type === 'subagent-message') {
                  return (
                    <MessageScrollerItem key={item.id} messageId={item.id} className="min-w-0">
                      <div className="px-4 pb-1 pt-3 md:px-6">
                        <div className="mx-auto w-full max-w-[56rem]">
                          <WorkspaceSubagentMessageRow
                            message={item.message}
                            revealRequest={
                              sessionItemRevealRequest?.itemType === 'subagent-message' &&
                              sessionItemRevealRequest.itemId === item.message.messageId
                                ? sessionItemRevealRequest
                                : undefined
                            }
                            annotationPort={annotationPortFor(activeTextAnnotations)}
                            onOpenSource={() => {
                              if (!currentSessionId) return
                              usePreviewWorkbenchStore
                                .getState()
                                .upsertAndActivateItem(
                                  createSessionSubagentsPreviewItem(
                                    currentSessionId,
                                    currentProjectId,
                                    item.message.sourceFrameId
                                  )
                                )
                            }}
                          />
                        </div>
                      </div>
                    </MessageScrollerItem>
                  )
                }

                if (item.type === 'handoff') {
                  return (
                    <MessageScrollerItem key={item.id} messageId={item.id} className="min-w-0">
                      <div className="px-4 pb-1 pt-3 md:px-6">
                        <div className="mx-auto w-full max-w-[56rem]">
                          <HandoffLifecycleStatus
                            handoff={item}
                            onRetry={
                              item.phase === 'failed' && onRetryHandoff
                                ? async () =>
                                    onRetryHandoff({
                                      sessionId: item.sessionId,
                                      originatingTurnId: item.originatingTurnId
                                    })
                                : undefined
                            }
                          />
                        </div>
                      </div>
                    </MessageScrollerItem>
                  )
                }

                if (item.type === 'plan-activity') {
                  return (
                    <WorkspacePlanActivityRecord
                      key={item.id}
                      activity={item.activity}
                      hasDurablePlanAuthority={item.activity.id === durablePlanOwnerActivityId}
                      revealRequest={
                        sessionItemRevealRequest?.itemType === 'plan' &&
                        sessionItemRevealRequest.itemId === item.activity.id
                          ? sessionItemRevealRequest
                          : undefined
                      }
                      annotationPort={annotationPortFor(activeTextAnnotations)}
                    />
                  )
                }

                if (item.type === 'compaction-activity') {
                  return (
                    <WorkspaceContextCompactionActivityRow key={item.id} activity={item.activity} />
                  )
                }

                if (item.type === 'session-config-change') {
                  return (
                    <WorkspaceSessionConfigChangeRow
                      key={item.id}
                      id={item.id}
                      agentTarget={item.agentTarget}
                    />
                  )
                }

                if (item.type === 'activity') {
                  if (!item.activity.elicitation) return null
                  const elicitationRequest =
                    pendingElicitations.find(
                      (request) => request.toolCallId === item.activity.id
                    ) ??
                    (activeSession && item.activity.elicitation.durable
                      ? {
                          requestId: item.activity.elicitation.durable.requestId,
                          sessionId: activeSession.id,
                          toolCallId: item.activity.id,
                          message: item.activity.elicitation.message,
                          fields: item.activity.elicitation.fields,
                          durable: item.activity.elicitation.durable
                        }
                      : undefined)
                  return (
                    <MessageScrollerItem key={item.id} messageId={item.id} className="min-w-0">
                      <div className="px-4 pb-1 pt-3 md:px-6">
                        <div className="mx-auto w-full max-w-4xl">
                          <WorkspaceElicitationCard
                            key={elicitationRequest?.requestId ?? item.activity.id}
                            elicitation={item.activity.elicitation}
                            request={elicitationRequest}
                            variant={
                              item.activity.elicitation.state === 'pending'
                                ? 'pending-placeholder'
                                : 'default'
                            }
                            annotationPort={
                              item.activity.elicitation.durable
                                ? annotationPortFor(activeTextAnnotations)
                                : undefined
                            }
                            annotationItemId={item.activity.id}
                            revealRequest={
                              sessionItemRevealRequest?.itemType === 'elicitation' &&
                              sessionItemRevealRequest.itemId === item.activity.id
                                ? sessionItemRevealRequest
                                : undefined
                            }
                          />
                        </div>
                      </div>
                    </MessageScrollerItem>
                  )
                }

                return (
                  <WorkspaceActivityGroup
                    key={item.id}
                    group={item}
                    isExpanded={!collapsedActivityGroups.has(item.id)}
                    onToggleGroup={toggleActivityGroup}
                    expansionOverrides={activityExpansionOverrides}
                    onToggleRow={toggleActivityRow}
                    notebookRunsById={notebookRunsById}
                    onNotebookRunNearViewport={handleNotebookRunNearViewport}
                    permission={activeSession?.runtimeContext?.permission}
                    jobsByActivityId={jobsByActivityId}
                    onOpenJobDetail={handleOpenJobDetail}
                    annotationPort={annotationPortFor(activeTextAnnotations)}
                    revealRequest={
                      sessionItemRevealRequest?.itemType === 'tool-activity'
                        ? sessionItemRevealRequest
                        : undefined
                    }
                  />
                )
              })}

              {/* Render any remaining unbound completed jobs after all conversation items */}
              {transcriptWindow.end === conversationItems.length
                ? trailingJobs.map((job) => (
                    <MessageScrollerItem
                      key={`completed-job-${job.job_id}`}
                      messageId={`completed-job-${job.job_id}`}
                      className="min-w-0"
                    >
                      <div className="px-4 py-1 md:px-6">
                        <div className="mx-auto w-full max-w-4xl">
                          <CompletedJobCard job={job} onOpen={handleOpenJobDetail} />
                        </div>
                      </div>
                    </MessageScrollerItem>
                  ))
                : null}

              {optimisticMessage ? (
                <WorkspaceMessageItem
                  message={optimisticMessage}
                  projectId={currentProjectId}
                  onPreviewArtifact={onPreviewArtifact}
                  onPreviewArtifactModal={onPreviewArtifactModal}
                  onPreviewUploadAttachment={onPreviewUploadAttachment}
                  onOpenSkillMention={onOpenSkillMention}
                  onPreviewMentionArtifact={onPreviewMentionArtifact}
                  showUserActions={false}
                  sending
                />
              ) : null}

              {presentationBarrierIndex < 0 ? trailingContent : null}

              {isResumingSession && activeSession ? (
                <WorkspaceAgentLoadingRow
                  sessionId={activeSession.id}
                  phase="resuming"
                  visiblePermissionPending={visiblePermissionPending}
                />
              ) : agentLoadingPhase !== 'hidden' && activeSession ? (
                <WorkspaceAgentLoadingRow
                  sessionId={activeSession.id}
                  phase={agentLoadingPhase}
                  agentStatus={activeSession.agentStatus}
                  visiblePermissionPending={
                    visiblePermissionPending || activeSession.status === 'waiting-plan-approval'
                  }
                />
              ) : null}
            </MessageScrollerContent>
          </MessageScrollerViewport>

          {showScrollToFirstMessage ? (
            <MessageScrollerButton
              ref={scrollToFirstMessageButtonRef}
              direction="start"
              onClick={() => {
                const firstMessage = conversationItems.find((item) => item.type === 'message')
                if (firstMessage?.type === 'message') {
                  transcriptWindow.revealMessage(firstMessage.message.id)
                }
              }}
              aria-label={t('Scroll to first message')}
              aria-hidden="true"
              data-revealed="false"
              tabIndex={-1}
              size="default"
              className="z-20 gap-1 rounded-full border-transparent bg-bg-000 px-3 text-sm shadow-card transition-[translate,scale,opacity] hover:bg-bg-200 data-[direction=start]:top-3 data-[revealed=false]:pointer-events-none data-[revealed=false]:-translate-y-2 data-[revealed=false]:opacity-0 motion-reduce:transition-none [&_svg]:size-3.5"
            >
              <ArrowDownIcon aria-hidden="true" />
              <span>{t('First message')}</span>
            </MessageScrollerButton>
          ) : null}

          <MessageScrollerButton
            size="icon-lg"
            className="z-10 rounded-full border-transparent bg-bg-000 shadow-card hover:bg-bg-200 data-[direction=end]:bottom-3"
          />
          <div
            data-testid="message-completion-live-region"
            aria-live="polite"
            aria-atomic="true"
            className="sr-only"
          >
            {terminalAnnouncement?.status === 'complete' ? (
              <span key={`${terminalAnnouncement.messageId}:complete`}>
                {t('Response completed.')}
              </span>
            ) : null}
          </div>
          <div
            data-testid="message-failure-live-region"
            aria-live="assertive"
            aria-atomic="true"
            className="sr-only"
          >
            {terminalAnnouncement?.status === 'error' ? (
              <span key={`${terminalAnnouncement.messageId}:error`}>{t('Response failed.')}</span>
            ) : null}
          </div>

          {/* Transient warning shown when a mention target no longer resolves to a file or skill. */}
          <div
            data-testid="mention-notice-live-region"
            aria-live="assertive"
            aria-atomic="true"
            className="pointer-events-none absolute inset-x-0 bottom-14 z-10 flex justify-center px-4"
          >
            {mentionNotice ? (
              <span className="rounded-full border border-border-200 bg-bg-000 px-3 py-1 text-[13px] text-text-100 shadow-card">
                {mentionNotice}
              </span>
            ) : null}
          </div>
        </MessageScroller>
      </MessageScrollerProvider>

      {/* Job detail modal — opened from RemoteJobRow or CompletedJobCard */}
      {currentSessionId && (
        <JobDetailModal
          open={modalOpen}
          sessionId={currentSessionId}
          initialJob={modalJob}
          onClose={handleCloseModal}
        />
      )}
    </>
  )
}

// Composer controls above the transcript react to reviewer lifecycle changes. Keep those parent
// renders from rebuilding an unchanged transcript; review cards maintain their own scoped subscription.
const areSessionsEqualForTranscript = (
  previous: ChatSession | undefined,
  next: ChatSession | undefined
): boolean => {
  if (Object.is(previous, next)) return true
  if (!previous || !next) return false

  // WorkspacePage mirrors reviewer activity into this transient operation gate. It changes the
  // ChatSession object identity but is not rendered by the transcript, so compare every other field.
  const previousKeys = Object.keys(previous).filter(
    (key) => key !== 'branchSwitchBlocked'
  ) as Array<keyof ChatSession>
  const nextKeys = Object.keys(next).filter((key) => key !== 'branchSwitchBlocked') as Array<
    keyof ChatSession
  >

  return (
    previousKeys.length === nextKeys.length &&
    previousKeys.every((key) => Object.is(previous[key], next[key]))
  )
}

// The composer draft is immutable snapshots (add/update/remove rebuild the array while keeping
// element identity), so element-wise comparison is both exact and cheap.
const areAnnotationsEqual = (
  previous: readonly Annotation[] | undefined,
  next: readonly Annotation[] | undefined
): boolean => {
  if (previous === next) return true
  const left = previous ?? []
  const right = next ?? []
  return (
    left.length === right.length && left.every((annotation, index) => annotation === right[index])
  )
}

const areWorkspaceMessageScrollerPropsEqual = (
  previous: WorkspaceMessageScrollerProps,
  next: WorkspaceMessageScrollerProps
): boolean =>
  previous.onSendEditedMessage === next.onSendEditedMessage &&
  (previous.credentialPending ?? false) === (next.credentialPending ?? false) &&
  (previous.visiblePermissionPending ?? false) === (next.visiblePermissionPending ?? false) &&
  previous.optimisticMessage === next.optimisticMessage &&
  (previous.canBranchInNewSession ?? false) === (next.canBranchInNewSession ?? false) &&
  (previous.reportPresentationRevealing ?? false) === (next.reportPresentationRevealing ?? false) &&
  previous.onBranchInNewSession === next.onBranchInNewSession &&
  previous.trailingContent === next.trailingContent &&
  previous.isResumingSession === next.isResumingSession &&
  previous.onAddAnnotation === next.onAddAnnotation &&
  previous.onUpdateAnnotationNote === next.onUpdateAnnotationNote &&
  previous.onAnnotationError === next.onAnnotationError &&
  areAnnotationsEqual(previous.annotations, next.annotations) &&
  previous.notebookReference?.sessionId === next.notebookReference?.sessionId &&
  (previous.notebookReference ? resolveProjectId(previous.notebookReference) : undefined) ===
    (next.notebookReference ? resolveProjectId(next.notebookReference) : undefined) &&
  previous.notebookReference?.workspaceCwd === next.notebookReference?.workspaceCwd &&
  areSessionsEqualForTranscript(previous.activeSession, next.activeSession)

const WorkspaceMessageScroller = memo(
  WorkspaceMessageScrollerImpl,
  areWorkspaceMessageScrollerPropsEqual
)
WorkspaceMessageScroller.displayName = 'WorkspaceMessageScroller'

export { WorkspaceMessageScroller }
