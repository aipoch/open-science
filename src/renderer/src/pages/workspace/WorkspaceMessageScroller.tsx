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
import { selectProjectSessionReviews, useReviewStore } from '@/stores/review-store'
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
import { useVirtualizer } from '@tanstack/react-virtual'

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
import { ReviewerCard } from '@/components/ReviewerCard'
import { WorkspaceActivityGroup } from './WorkspaceActivityGroup'
import { WorkspaceContextCompactionActivityRow } from './WorkspaceContextCompactionActivityRow'
import { WorkspacePlanActivityRecord } from './WorkspacePlanActivityRecord'
import { parseGeneratePlanDocument } from './generate-plan-activity-projection'
import { WorkspaceAgentLoadingRow } from './WorkspaceAgentLoadingRow'
import { WorkspaceMessageItem } from './WorkspaceMessageItem'
import type { ArtifactMentionPart } from './WorkspaceMessageItem'
import { useWorkspaceArtifactVisibility, type MessageArtifact } from './WorkspaceArtifactVisibility'
import { useWorkspaceMessageEditState } from './workspace-message-edit-state-context'
import {
  createConversationItems,
  resolveTurnTerminalAgentMessageIds
} from './workspace-conversation-items'
import { groupConversationItems } from './workspace-tool-activity-groups'
import type { ActivityExpansionOverrides } from './workspace-tool-activity-groups'
import { useSessionJobStore } from '@/stores/session-job-store'
import type { GoToTranscriptIntent, ReviewWithChecks } from '../../../../shared/reviewer'
import type { ComposerDoc } from './composer/composer-doc'
import type {
  HandoffLifecycleEventSource,
  HandoffRetryRequest
} from '../../../../shared/handoff-lifecycle'
import type { PendingElicitationRequest } from '../../../../shared/acp'
import { HandoffLifecycleStatus } from './HandoffLifecycleStatus'
import { useHandoffLifecycleEvents } from './useHandoffLifecycleEvents'
import type { NotebookSessionReference } from '../../../../shared/notebook'
import { useNotebookRunsById } from './use-notebook-runs-by-id'
import { WorkspaceElicitationCard } from './WorkspaceElicitationCard'
import { WorkspaceSubagentMessageRow } from './WorkspaceSubagentMessageRow'

type WorkspaceMessageScrollerProps = {
  activeSession: ChatSession | undefined
  isResumingSession?: boolean
  notebookReference?: NotebookSessionReference
  onSendEditedMessage: (messageId: string, doc: ComposerDoc) => void
  trailingContent?: ReactNode
  pendingElicitations?: PendingElicitationRequest[]
  // Events are read-only projections; retry sends an intent that main validates against its state.
  handoffLifecycleSource?: HandoffLifecycleEventSource
  onRetryHandoff?: (request: HandoffRetryRequest) => Promise<void>
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
const SCROLL_TO_FIRST_MESSAGE_MIN_USER_TURNS = 2
const SCROLL_TO_FIRST_MESSAGE_MIN_HEIGHT_VIEWPORTS = 2
const SCROLL_TO_FIRST_MESSAGE_MIN_PROGRESS = 0.1
const SCROLL_TO_FIRST_MESSAGE_MIN_DISTANCE_VIEWPORTS = 1
const SCROLL_TO_FIRST_MESSAGE_IDLE_TIMEOUT_MS = 3000
// How long a "no longer available" mention notice stays visible before auto-dismissing.
const MENTION_NOTICE_TIMEOUT_MS = 3000
// Transcripts larger than this render through a virtualizer-owned window; smaller ones keep the
// primitive's direct-children measurement path, which owns anchoring for them.
const VIRTUALIZATION_ROW_THRESHOLD = 100
const SCROLL_PREVIOUS_ITEM_PEEK = 64
const SCROLL_FOLLOW_EDGE_PX = 8
// Stable fallbacks keep memoized transcript rows from rebuilding when session-scoped UI state
// belongs to a different session/scope.
const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>()
const EMPTY_EXPANSION_OVERRIDES: ActivityExpansionOverrides = {}

// One flattened transcript row. The virtualized path positions these absolutely; the classic path
// renders them as direct content children in the same order.
type TranscriptRow = {
  key: string
  estimatedSize: number
  scrollAnchor: boolean
  node: () => React.JSX.Element | null
}

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
      findingId: intent.findingId,
      locator: intent.locator
    })
  )
}

type WorkspaceMessageReviewProps = {
  projectId: string | undefined
  sessionId: string
  turnMessageId: string
  onGoToTranscript: (intent: GoToTranscriptIntent) => void
  onRerun: (review: ReviewWithChecks) => Promise<boolean>
}

// Keep reviewer updates local to their card. Subscribing the transcript parent to the whole Session
// review array made every reviewer push rebuild every rich Markdown message in large conversations.
const WorkspaceMessageReview = ({
  projectId,
  sessionId,
  turnMessageId,
  onGoToTranscript,
  onRerun
}: WorkspaceMessageReviewProps): React.JSX.Element | null => {
  const review = useReviewStore((state) =>
    selectProjectSessionReviews(state.reviewsBySession, projectId, sessionId).find(
      (candidate) => candidate.turnMessageId === turnMessageId
    )
  )

  if (!review) return null
  return (
    <MessageScrollerItem messageId={`review-${turnMessageId}`} className="min-w-0">
      <div className="px-4 pb-1 md:px-6">
        <div className="mx-auto w-full max-w-[56rem]">
          {/* Only "Go to transcript" navigates to the reviewer page; the card itself does not. */}
          <ReviewerCard review={review} onGoToTranscript={onGoToTranscript} onRerun={onRerun} />
        </div>
      </div>
    </MessageScrollerItem>
  )
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
  isResumingSession = false,
  notebookReference,
  onSendEditedMessage,
  trailingContent,
  pendingElicitations = [],
  handoffLifecycleSource,
  onRetryHandoff
}: WorkspaceMessageScrollerProps): React.JSX.Element => {
  const currentSessionId = activeSession?.id
  const currentProjectId = activeSession?.projectId
  const statusAllowsScrollToFirstMessage = Boolean(
    activeSession &&
    activeSession.status !== 'running' &&
    !activeSession.status.startsWith('waiting-') &&
    !activeSession.compacting
  )
  const messageScrollerViewportRef = useRef<HTMLDivElement | null>(null)
  const messageScrollerContentRef = useRef<HTMLDivElement | null>(null)
  const scrollToFirstMessageButtonRef = useRef<HTMLButtonElement | null>(null)
  const previousMessageScrollerScrollTopRef = useRef(0)
  const scrollToFirstMessageHideTimeoutRef = useRef<number | undefined>(undefined)
  // Virtualized-path scroll engine state (used only past VIRTUALIZATION_ROW_THRESHOLD rows).
  const virtualizationEnabledRef = useRef(false)
  const virtualScrollStateRef = useRef<{
    scopeId: string | undefined
    initialized: boolean
    follow: boolean
    handledAnchorKeys: Set<string>
  }>({ scopeId: undefined, initialized: false, follow: true, handledAnchorKeys: new Set() })
  const [scrollThresholdAllowsFirstMessage, setScrollThresholdAllowsFirstMessage] = useState(false)
  const activeConversationFrame = activeSession?.conversationGraph?.frames.find(
    (frame) => frame.id === activeSession.conversationGraph?.activeFrameId
  )
  const currentPresentationScopeId = currentSessionId
    ? JSON.stringify([currentSessionId, activeConversationFrame?.activeBranchId ?? 'legacy'])
    : undefined
  const artifactVisibility = useWorkspaceArtifactVisibility(activeSession)
  const artifactsForMessage = artifactVisibility.artifactsForMessage
  const notebookRunsById = useNotebookRunsById(notebookReference)
  const handoffEvents = useHandoffLifecycleEvents(handoffLifecycleSource, currentSessionId)
  // The whole-window find bar is an Electron overlay owned by main; the Workspace only needs to tell
  // main it is mounted and searchable so Cmd/Ctrl+F is intercepted (and re-arm UNREADY on unmount).
  useEffect(() => {
    const stop = window.api?.window?.announceWindowFindReady?.()
    return () => stop?.()
  }, [])
  const loadReviewsForSession = useReviewStore((state) => state.loadReviewsForSession)

  // Job store for binding and CompletedJobCard rendering
  const jobsById = useSessionJobStore((s) => s.jobsById)
  const hydrateJobs = useSessionJobStore((s) => s.hydrate)

  // Hydrate the job store when the active session changes
  useEffect(() => {
    // Guard against test environments where window.api.compute may not be available
    if (currentSessionId && typeof window.api?.compute?.jobsList === 'function') {
      void hydrateJobs(currentSessionId)
    }
  }, [currentSessionId, hydrateJobs])

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
  const [messagePresentationState, setMessagePresentationState] =
    useState<SessionScopedMessagePresentationState>(() => ({
      scopeId: undefined,
      messageIds: new Set()
    }))
  const collapsedActivityGroups =
    collapsedActivityGroupState.sessionId === currentSessionId
      ? collapsedActivityGroupState.groupIds
      : EMPTY_ID_SET
  const activityExpansionOverrides =
    activityExpansionOverrideState.sessionId === currentSessionId
      ? activityExpansionOverrideState.overrides
      : EMPTY_EXPANSION_OVERRIDES
  const rawConversationItems = useMemo(
    () => createConversationItems(activeSession, handoffEvents),
    [activeSession, handoffEvents]
  )
  const conversationItems = useMemo(
    () => groupConversationItems(rawConversationItems, activeSession?.activityGroups),
    [activeSession?.activityGroups, rawConversationItems]
  )
  const [visibleMessageSnapshot, setVisibleMessageSnapshot] = useState<VisibleMessageSnapshot>(
    () => ({ scopeId: undefined, messageIds: new Set() })
  )
  const presentationScopeRemainedVisible =
    visibleMessageSnapshot.scopeId === currentPresentationScopeId
  const presentingMessageIds =
    messagePresentationState.scopeId === currentPresentationScopeId
      ? messagePresentationState.messageIds
      : EMPTY_ID_SET
  const presentationBarrierIndex = conversationItems.findIndex(
    (item) => item.type === 'message' && presentingMessageIds.has(item.message.id)
  )
  const presentedConversationItems =
    presentationBarrierIndex >= 0
      ? conversationItems.slice(0, presentationBarrierIndex + 1)
      : conversationItems
  const visibleMessageIds = presentedConversationItems.flatMap((item) =>
    item.type === 'message' ? [item.message.id] : []
  )
  const visibleMessageIdsKey = JSON.stringify(visibleMessageIds)
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
  const handleMessageScrollerScroll = useCallback((): void => {
    const viewport = messageScrollerViewportRef.current
    if (!viewport) return

    const previousScrollTop = previousMessageScrollerScrollTopRef.current
    previousMessageScrollerScrollTopRef.current = viewport.scrollTop
    if (virtualizationEnabledRef.current) {
      // The virtualized path owns follow-output: release on any upward scroll, re-engage at the
      // live edge. Downward programmatic pins never release.
      const followState = virtualScrollStateRef.current
      const maximumScrollTop = viewport.scrollHeight - viewport.clientHeight
      if (viewport.scrollTop >= maximumScrollTop - SCROLL_FOLLOW_EDGE_PX) followState.follow = true
      else if (viewport.scrollTop < previousScrollTop) followState.follow = false
    }
    const eligible = updateScrollToFirstMessageEligibility()
    if (viewport.scrollTop < previousScrollTop && eligible) revealScrollToFirstMessage()
    else if (viewport.scrollTop > previousScrollTop) hideScrollToFirstMessage()
  }, [hideScrollToFirstMessage, revealScrollToFirstMessage, updateScrollToFirstMessageEligibility])
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
    const observer = new ResizeObserver(updateScrollToFirstMessageEligibility)
    const viewport = messageScrollerViewportRef.current
    const content = messageScrollerContentRef.current
    if (viewport) observer.observe(viewport)
    if (content) observer.observe(content)
    return () => observer.disconnect()
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
  // Assistant text can be split into several messages around tool calls. All fragments share the
  // prompt they respond to, but only the last visible fragment in that turn owns whole-turn metadata.
  // Legacy unlinked messages remain independent so older transcripts do not lose their timestamps.
  const assistantFooterMessageIds = useMemo(
    () => resolveTurnTerminalAgentMessageIds(activeSession?.messages ?? []),
    [activeSession?.messages]
  )
  const agentLoadingPhase = getAgentLoadingPhase(activeSession)
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

    const allActivities = activeSession?.activities ?? []
    for (const job of sessionJobs) {
      // Scan all activities for this job_id
      for (const activity of allActivities) {
        const extracted = extractJobIdFromActivity(activity)
        if (extracted === job.job_id) {
          byActivityId.set(job.job_id, job)
          bound.add(job.job_id)
          break // Found — no need to scan further activities for this job
        }
      }
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
  const toggleActivityGroup = useCallback(
    (groupId: string): void => {
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
    },
    [currentSessionId]
  )

  // Records the user's explicit expansion choice for a single tool-activity detail row.
  const toggleActivityRow = useCallback(
    (activityId: string, nextExpanded: boolean): void => {
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
    },
    [currentSessionId]
  )

  // Opens the Session reviewer panel positioned at the finding the user clicked.
  // Only the "Go to transcript" button on a finding fires this; clicking the card itself does not.
  const handleGoToTranscript = useCallback(
    (intent: GoToTranscriptIntent): void => {
      if (!currentSessionId) return
      openSessionReviewer(currentSessionId, intent)
    },
    [currentSessionId]
  )

  // Re-runs the review for a specific (stale) turn — the actionable refresh the stale notice offers.
  // Unlike the composer's last-turn-only "Request review", this reaches any turn's review. The row is
  // grouped under review.turnMessageId (so a fix-loop review refreshes in place), but the audited
  // content is review.scope.turnMessageId — the turn whose bytes actually changed. Fire-and-forget:
  // a fresh review supersedes the stale one via reviewer:updated; concurrent runs are deduped in main.
  const handleRerunReview = useCallback(async (review: ReviewWithChecks): Promise<boolean> => {
    try {
      const result = await window.api.reviewer.run({
        sessionId: review.sessionId,
        turnMessageId: review.turnMessageId,
        scopeTurnMessageId: review.scope.turnMessageId,
        projectId: review.projectId,
        mainSessionId: review.sessionId,
        model: useSettingsStore.getState().activeModel,
        // Explicit user Re-run: bypass main's auto-only per-turn idempotency so the stale/error review
        // is genuinely re-run rather than refused as already-reviewed.
        origin: 'manual'
      })
      return result?.started ?? false
    } catch {
      return false
    }
  }, [])

  // Flatten the transcript timeline into row descriptors. The classic path renders them as
  // direct content children (identical DOM to before); the virtualized path mounts only the
  // window the virtualizer covers. Kept memoized so virtualizer window shifts during scrolling
  // do not rebuild descriptors for the whole transcript.
  const transcriptRows = useMemo<readonly TranscriptRow[]>(() => {
    const messageCreatedAtById = new Map(
      activeSession?.messages.map((message) => [message.id, message.createdAt]) ?? []
    )

    // Counts the user turns after each message; the destructive-resend warning keys off turns, not
    // raw message count, so a single follow-up turn stays warning-free.
    const subsequentTurnCountByMessageId = new Map<string, number>()
    if (activeSession) {
      let subsequentTurns = 0
      for (let index = activeSession.messages.length - 1; index >= 0; index -= 1) {
        const message = activeSession.messages[index]
        subsequentTurnCountByMessageId.set(message.id, subsequentTurns)
        if (message.role === 'user') subsequentTurns += 1
      }
    }

    const rows: TranscriptRow[] = []
    // Messages and tool activities share one sorted transcript timeline.
    conversationItems.forEach((item, itemIndex) => {
      // Only later text messages stay behind the presentation barrier; tool,
      // activity, and other non-message rows render in real time so their
      // running state stays visible while the reply paces above them.
      if (
        presentationBarrierIndex >= 0 &&
        itemIndex > presentationBarrierIndex &&
        (item.type === 'message' || item.type === 'subagent-message')
      ) {
        return
      }

      if (item.type === 'message') {
        const artifacts = artifactsForMessage(item.message)
        // Jobs pre-assigned to this slot: each job appears in exactly one slot.
        const jobsBeforeMessage = jobSlotsByItemIndex.get(itemIndex) ?? []
        const graph = activeSession?.conversationGraph
        const messageNode = graph?.messages.find((message) => message.id === item.message.id)
        const runtimeSegment = messageNode?.runtimeSegmentId
          ? graph?.runtimeSegments.find((segment) => segment.id === messageNode.runtimeSegmentId)
          : undefined
        // Legacy sessions synthesize this segment with a fallback framework. Keep only
        // the session-level values that were actually persisted.
        const synthesizedLegacyRuntime =
          runtimeSegment?.id === `runtime-segment-${activeSession?.id}` &&
          !activeSession?.agentFrameworkId
        const runtimeIdentity = synthesizedLegacyRuntime ? legacyRuntimeIdentity : runtimeSegment
        const revisionRootMessageId = messageNode?.revisionRootMessageId
        const revisions = revisionRootMessageId
          ? (graph?.messages
              .filter(
                (message) =>
                  message.role === 'user' && message.revisionRootMessageId === revisionRootMessageId
              )
              .sort(
                (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)
              ) ?? [])
          : []
        const revisionIndex = revisions.findIndex((message) => message.id === item.message.id)
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
          onPreviewArtifact,
          onPreviewUploadAttachment,
          onOpenSkillMention,
          onPreviewMentionArtifact,
          onSendEditedMessage,
          turnStartedAt: item.message.responseToMessageId
            ? messageCreatedAtById.get(item.message.responseToMessageId)
            : undefined,
          runtimeIdentity,
          showAssistantFooter:
            item.message.role !== 'agent' || assistantFooterMessageIds.has(item.message.id),
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
          artifacts
        }
        if (item.message.role === 'agent') {
          messageItemProps.onPresentationChange = handleMessagePresentationChange
          messageItemProps.presentationSourceOpen = itemIndex === conversationItems.length - 1
          messageItemProps.presentationAnimateOnMount =
            presentationScopeRemainedVisible &&
            !visibleMessageSnapshot.messageIds.has(item.message.id)
        }

        // Unbound completed jobs that belong chronologically before this message.
        for (const job of jobsBeforeMessage) {
          rows.push({
            key: `completed-job-${job.job_id}`,
            estimatedSize: 96,
            scrollAnchor: false,
            node: () => (
              <MessageScrollerItem messageId={`completed-job-${job.job_id}`} className="min-w-0">
                <div className="px-4 py-1 md:px-6">
                  <div className="mx-auto w-full max-w-4xl">
                    <CompletedJobCard job={job} onOpen={handleOpenJobDetail} />
                  </div>
                </div>
              </MessageScrollerItem>
            )
          })
        }
        // #1124: the composite key remounts the message row when the presentation scope changes.
        const messageRowKey = JSON.stringify([currentPresentationScopeId, item.id])
        rows.push({
          key: messageRowKey,
          estimatedSize: item.message.role === 'user' ? 46 : 336,
          scrollAnchor: item.message.role === 'user',
          node: () =>
            item.message.role === 'user' ? (
              <EditableWorkspaceMessageItem key={messageRowKey} {...messageItemProps} />
            ) : (
              <WorkspaceMessageItem
                key={messageRowKey}
                {...messageItemProps}
                canEditMessage={false}
              />
            )
        })
        if (
          currentSessionId &&
          item.message.role === 'agent' &&
          !presentingMessageIds.has(item.message.id)
        ) {
          const reviewSessionId = currentSessionId
          rows.push({
            key: `${messageRowKey}:review`,
            estimatedSize: 200,
            scrollAnchor: false,
            node: () => (
              <WorkspaceMessageReview
                projectId={currentProjectId}
                sessionId={reviewSessionId}
                turnMessageId={item.message.id}
                onGoToTranscript={handleGoToTranscript}
                onRerun={handleRerunReview}
              />
            )
          })
        }
        return
      }

      if (item.type === 'subagent-message') {
        rows.push({
          key: item.id,
          estimatedSize: 96,
          scrollAnchor: false,
          node: () => (
            <MessageScrollerItem messageId={item.id} className="min-w-0">
              <div className="px-4 pb-1 pt-3 md:px-6">
                <div className="mx-auto w-full max-w-[56rem]">
                  <WorkspaceSubagentMessageRow
                    message={item.message}
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
        })
        return
      }

      if (item.type === 'handoff') {
        rows.push({
          key: item.id,
          estimatedSize: 96,
          scrollAnchor: false,
          node: () => (
            <MessageScrollerItem messageId={item.id} className="min-w-0">
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
        })
        return
      }

      if (item.type === 'plan-activity') {
        rows.push({
          key: item.id,
          estimatedSize: 96,
          scrollAnchor: false,
          node: () => (
            <WorkspacePlanActivityRecord
              activity={item.activity}
              hasDurablePlanAuthority={item.activity.id === durablePlanOwnerActivityId}
            />
          )
        })
        return
      }

      if (item.type === 'compaction-activity') {
        rows.push({
          key: item.id,
          estimatedSize: 48,
          scrollAnchor: false,
          node: () => <WorkspaceContextCompactionActivityRow activity={item.activity} />
        })
        return
      }

      if (item.type === 'activity') {
        const elicitation = item.activity.elicitation
        if (!elicitation) return
        const elicitationRequest =
          pendingElicitations.find((request) => request.toolCallId === item.activity.id) ??
          (activeSession && elicitation.durable
            ? {
                requestId: elicitation.durable.requestId,
                sessionId: activeSession.id,
                toolCallId: item.activity.id,
                message: elicitation.message,
                fields: elicitation.fields,
                durable: elicitation.durable
              }
            : undefined)
        rows.push({
          key: item.id,
          estimatedSize: 200,
          scrollAnchor: false,
          node: () => (
            <MessageScrollerItem messageId={item.id} className="min-w-0">
              <div className="px-4 pb-1 pt-3 md:px-6">
                <div className="mx-auto w-full max-w-4xl">
                  <WorkspaceElicitationCard
                    key={elicitationRequest?.requestId ?? item.activity.id}
                    elicitation={elicitation}
                    request={elicitationRequest}
                    variant={elicitation.state === 'pending' ? 'pending-placeholder' : 'default'}
                  />
                </div>
              </div>
            </MessageScrollerItem>
          )
        })
        return
      }

      rows.push({
        key: item.id,
        estimatedSize: 96,
        scrollAnchor: false,
        node: () => (
          <WorkspaceActivityGroup
            group={item}
            isExpanded={!collapsedActivityGroups.has(item.id)}
            onToggleGroup={toggleActivityGroup}
            expansionOverrides={activityExpansionOverrides}
            onToggleRow={toggleActivityRow}
            notebookRunsById={notebookRunsById}
            permission={activeSession?.runtimeContext?.permission}
            jobsByActivityId={jobsByActivityId}
            onOpenJobDetail={handleOpenJobDetail}
          />
        )
      })
    })

    // Render any remaining unbound completed jobs after all conversation items.
    for (const job of trailingJobs) {
      rows.push({
        key: `completed-job-${job.job_id}`,
        estimatedSize: 96,
        scrollAnchor: false,
        node: () => (
          <MessageScrollerItem messageId={`completed-job-${job.job_id}`} className="min-w-0">
            <div className="px-4 py-1 md:px-6">
              <div className="mx-auto w-full max-w-4xl">
                <CompletedJobCard job={job} onOpen={handleOpenJobDetail} />
              </div>
            </div>
          </MessageScrollerItem>
        )
      })
    }

    if (presentationBarrierIndex < 0 && trailingContent != null) {
      rows.push({
        key: 'trailing-content',
        estimatedSize: 200,
        scrollAnchor: false,
        node: () => <>{trailingContent}</>
      })
    }

    if (isResumingSession && activeSession) {
      rows.push({
        key: 'agent-loading-resuming',
        estimatedSize: 64,
        scrollAnchor: false,
        node: () => <WorkspaceAgentLoadingRow sessionId={activeSession.id} phase="resuming" />
      })
    } else if (agentLoadingPhase !== 'hidden' && activeSession) {
      rows.push({
        key: 'agent-loading',
        estimatedSize: 64,
        scrollAnchor: false,
        node: () => (
          <WorkspaceAgentLoadingRow
            sessionId={activeSession.id}
            phase={agentLoadingPhase}
            agentStatus={activeSession.agentStatus}
          />
        )
      })
    }

    return rows
  }, [
    activeSession,
    activityExpansionOverrides,
    agentLoadingPhase,
    artifactsForMessage,
    assistantFooterMessageIds,
    collapsedActivityGroups,
    conversationItems,
    currentPresentationScopeId,
    currentProjectId,
    currentSessionId,
    durablePlanOwnerActivityId,
    handleGoToTranscript,
    handleMessagePresentationChange,
    handleOpenJobDetail,
    handleRerunReview,
    isResumingSession,
    jobSlotsByItemIndex,
    jobsByActivityId,
    legacyRuntimeIdentity,
    notebookRunsById,
    onPreviewArtifact,
    onPreviewMentionArtifact,
    onPreviewUploadAttachment,
    onOpenSkillMention,
    onRetryHandoff,
    onSendEditedMessage,
    pendingElicitations,
    presentationBarrierIndex,
    presentationScopeRemainedVisible,
    presentingMessageIds,
    toggleActivityGroup,
    toggleActivityRow,
    trailingContent,
    trailingJobs,
    visibleMessageSnapshot
  ])

  const virtualizationEnabled = transcriptRows.length > VIRTUALIZATION_ROW_THRESHOLD
  virtualizationEnabledRef.current = virtualizationEnabled
  const transcriptVirtualizer = useVirtualizer({
    count: transcriptRows.length,
    getScrollElement: () => messageScrollerViewportRef.current,
    estimateSize: (index) => transcriptRows[index]?.estimatedSize ?? 160,
    getItemKey: (index) => transcriptRows[index]?.key ?? index,
    overscan: 8
  })
  const transcriptVirtualSize = transcriptVirtualizer.getTotalSize()

  // With virtualization the primitive only sees the total-size wrapper as Content's child, so its
  // MutationObserver-driven behaviors never fire for transcript rows. Re-drive them against the
  // virtualizer: initial last-anchor position, new-turn anchoring, and follow-output pinning.
  // Follow state itself is maintained by handleMessageScrollerScroll.
  useLayoutEffect(() => {
    if (!virtualizationEnabled || transcriptVirtualSize <= 0) return
    const viewport = messageScrollerViewportRef.current
    if (!viewport) return
    const state = virtualScrollStateRef.current
    if (state.scopeId !== currentPresentationScopeId) {
      state.scopeId = currentPresentationScopeId
      state.initialized = false
      state.follow = true
      state.handledAnchorKeys = new Set()
    }
    const anchorIndexes: number[] = []
    transcriptRows.forEach((row, index) => {
      if (row.scrollAnchor) anchorIndexes.push(index)
    })
    // Land an anchor row at the viewport top with the previous-item peek above it. The offset
    // clamps to the scrollable range, so an anchor whose remaining content fits the viewport
    // naturally lands at the end, matching the primitive's last-anchor fallback.
    const scrollToAnchorIndex = (index: number): void => {
      const offset = transcriptVirtualizer.getOffsetForIndex(index, 'start')?.[0]
      if (offset === undefined) {
        transcriptVirtualizer.scrollToIndex(index, { align: 'start' })
        return
      }
      transcriptVirtualizer.scrollToOffset(Math.max(0, offset - SCROLL_PREVIOUS_ITEM_PEEK))
    }
    if (!state.initialized) {
      if (transcriptRows.length === 0) return
      state.initialized = true
      for (const index of anchorIndexes) state.handledAnchorKeys.add(transcriptRows[index].key)
      const lastAnchorIndex = anchorIndexes.at(-1)
      if (lastAnchorIndex === undefined) viewport.scrollTop = viewport.scrollHeight
      else scrollToAnchorIndex(lastAnchorIndex)
      return
    }
    const newAnchorIndexes = anchorIndexes.filter(
      (index) => !state.handledAnchorKeys.has(transcriptRows[index].key)
    )
    for (const index of anchorIndexes) state.handledAnchorKeys.add(transcriptRows[index].key)
    if (newAnchorIndexes.length > 0) {
      if (state.follow && newAnchorIndexes.length > 1) viewport.scrollTop = viewport.scrollHeight
      else scrollToAnchorIndex(newAnchorIndexes[0])
      return
    }
    if (state.follow) viewport.scrollTop = viewport.scrollHeight
  }, [
    currentPresentationScopeId,
    transcriptRows,
    transcriptVirtualSize,
    transcriptVirtualizer,
    virtualizationEnabled
  ])

  return (
    <>
      <MessageScrollerProvider
        key={activeSession?.id ?? 'empty-conversation'}
        autoScroll
        defaultScrollPosition="last-anchor"
        scrollPreviousItemPeek={SCROLL_PREVIOUS_ITEM_PEEK}
      >
        <MessageScroller className="relative min-h-0 flex-1 bg-bg-10">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-bg-10 to-bg-10/0"
          />
          <MessageScrollerViewport
            ref={messageScrollerViewportRef}
            aria-label="Conversation"
            onScroll={handleMessageScrollerScroll}
          >
            <MessageScrollerContent
              ref={messageScrollerContentRef}
              className={
                virtualizationEnabled
                  ? 'block min-h-full gap-0 px-4 pb-[56px]'
                  : 'gap-0 px-4 pb-[56px]'
              }
            >
              <VisibleMessageSnapshotCommit
                scopeId={currentPresentationScopeId}
                messageIdsKey={visibleMessageIdsKey}
                onCommit={handleVisibleMessageSnapshotCommit}
              />
              {virtualizationEnabled ? (
                // The primitive's MutationObserver only watches Content's direct children, so the
                // virtualizer owns row mounting inside one total-size wrapper; scroll behaviors are
                // re-driven by the layout effect above.
                <div className="relative w-full" style={{ height: transcriptVirtualSize }}>
                  {transcriptVirtualizer.getVirtualItems().map((virtualItem) => {
                    const row = transcriptRows[virtualItem.index]
                    if (!row) return null
                    return (
                      <div
                        key={virtualItem.key}
                        ref={transcriptVirtualizer.measureElement}
                        data-index={virtualItem.index}
                        className="absolute start-0 top-0 w-full"
                        style={{ transform: `translateY(${virtualItem.start}px)` }}
                      >
                        {row.node()}
                      </div>
                    )
                  })}
                </div>
              ) : (
                // No wrapper div: message-scroller only measures/anchors Content's direct children.
                transcriptRows.map((row) => <Fragment key={row.key}>{row.node()}</Fragment>)
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>

          {showScrollToFirstMessage ? (
            <MessageScrollerButton
              ref={scrollToFirstMessageButtonRef}
              direction="start"
              aria-label="Scroll to first message"
              aria-hidden="true"
              data-revealed="false"
              tabIndex={-1}
              size="default"
              className="z-20 min-h-11 gap-1 rounded-full border-transparent bg-bg-000 px-4 text-sm shadow-card transition-[translate,scale,opacity] hover:bg-bg-200 data-[direction=start]:top-3 data-[revealed=false]:pointer-events-none data-[revealed=false]:-translate-y-2 data-[revealed=false]:opacity-0 motion-reduce:transition-none"
            >
              <ArrowDownIcon aria-hidden="true" />
              <span>First message</span>
            </MessageScrollerButton>
          ) : null}

          <MessageScrollerButton className="z-10 border-transparent bg-bg-000 shadow-card hover:bg-bg-200 data-[direction=end]:bottom-3" />
          <div
            data-testid="message-completion-live-region"
            aria-live="polite"
            aria-atomic="true"
            className="sr-only"
          >
            {terminalAnnouncement?.status === 'complete' ? (
              <span key={`${terminalAnnouncement.messageId}:complete`}>Response completed.</span>
            ) : null}
          </div>
          <div
            data-testid="message-failure-live-region"
            aria-live="assertive"
            aria-atomic="true"
            className="sr-only"
          >
            {terminalAnnouncement?.status === 'error' ? (
              <span key={`${terminalAnnouncement.messageId}:error`}>Response failed.</span>
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

const areWorkspaceMessageScrollerPropsEqual = (
  previous: WorkspaceMessageScrollerProps,
  next: WorkspaceMessageScrollerProps
): boolean =>
  previous.onSendEditedMessage === next.onSendEditedMessage &&
  previous.trailingContent === next.trailingContent &&
  previous.isResumingSession === next.isResumingSession &&
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
