import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport
} from '@/components/ui/message-scroller'
import {
  usePreviewWorkbenchStore,
  createSessionReviewerPreviewItem
} from '@/stores/preview-workbench-store'
import { selectProjectSessionReviews, useReviewStore } from '@/stores/review-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useSessionStore, type ChatSession } from '@/stores/session-store'
import { flushSessionPersistence } from '@/lib/session-persistence/session-persistence'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'

import { shouldShowAgentLoadingMessage } from './agent-loading-message'
import {
  createPreviewFileItemFromArtifact,
  createPreviewFileItemFromMention,
  createPreviewFileItemFromUpload
} from './preview-file-item'
import { createPreviewRequestScope } from './previews/preview-file-reader'
import type { JobSummary } from '../../../../shared/compute'
import { CompletedJobCard } from '@/components/CompletedJobCard'
import { JobDetailModal } from '@/components/JobDetailModal'
import { extractJobIdFromActivity } from '@/components/job-binding-utils'
import { MessageScrollerItem } from '@/components/ui/message-scroller'
import { ReviewerCard } from '@/components/ReviewerCard'
import { WorkspaceActivityGroup } from './WorkspaceActivityGroup'
import { WorkspaceAgentLoadingRow } from './WorkspaceAgentLoadingRow'
import { WorkspaceMessageItem } from './WorkspaceMessageItem'
import type { ArtifactMentionPart } from './WorkspaceMessageItem'
import { useWorkspaceMessageEditState } from './workspace-message-edit-state-context'
import { createConversationItems } from './workspace-conversation-items'
import { groupConversationItems } from './workspace-tool-activity-groups'
import type { ActivityExpansionOverrides } from './workspace-tool-activity-groups'
import { useSessionJobStore } from '@/stores/session-job-store'
import type { GoToTranscriptIntent, ReviewWithChecks } from '../../../../shared/reviewer'
import type { ComposerDoc } from './composer/composer-doc'
import type {
  HandoffLifecycleEventSource,
  HandoffRetryRequest
} from '../../../../shared/handoff-lifecycle'
import { HandoffLifecycleStatus } from './HandoffLifecycleStatus'
import { useHandoffLifecycleEvents } from './useHandoffLifecycleEvents'
import { MAX_ARTIFACT_VERSION_DESCRIPTOR_IDS } from '../../../../shared/artifacts'
import {
  createArtifactVersionLocator,
  type ArtifactVersionDescriptor
} from '../../../../shared/artifact-provenance'

type WorkspaceMessageScrollerProps = {
  activeSession: ChatSession | undefined
  onSendEditedMessage: (messageId: string, doc: ComposerDoc) => void
  // Events are read-only projections; retry sends an intent that main validates against its state.
  handoffLifecycleSource?: HandoffLifecycleEventSource
  onRetryHandoff?: (request: HandoffRetryRequest) => Promise<void>
}

type SessionScopedActivityGroupState = {
  sessionId: string | undefined
  groupIds: Set<string>
}

type SessionScopedActivityExpansionState = {
  sessionId: string | undefined
  overrides: ActivityExpansionOverrides
}

type MessageArtifact = NonNullable<ChatSession['artifacts']>[number] & {
  // A copied message owns no artifact metadata. Resolver results retain the Version's real owner so
  // the preview locator continues to address immutable source bytes rather than the new Session.
  resolvedProjectId?: string
  resolvedSessionId?: string
}
type MessageUploadAttachment = NonNullable<ChatSession['messages'][number]['uploads']>[number]
const conversationContentClassName = 'relative mx-auto w-full max-w-4xl pb-[56px]'
// How long a "no longer available" mention notice stays visible before auto-dismissing.
const MENTION_NOTICE_TIMEOUT_MS = 3000

// Resolves a message's artifact ids against the session-level artifact metadata store.
const getMessageArtifacts = (
  session: ChatSession,
  message: ChatSession['messages'][number],
  resolvedArtifactsByVersionId?: ReadonlyMap<string, MessageArtifact | undefined>
): MessageArtifact[] => {
  if (!message.artifactIds) return []

  const artifactsById = new Map(
    (session.artifacts ?? []).map((artifact) => [artifact.id, artifact as MessageArtifact])
  )
  const artifactsByLogicalId = new Map<string, MessageArtifact>()

  for (const artifactId of message.artifactIds) {
    const artifact = artifactsById.get(artifactId) ?? resolvedArtifactsByVersionId?.get(artifactId)
    if (!artifact) continue

    const logicalId = artifact.versionId
      ? `version:${artifact.versionId}`
      : `artifact:${artifact.id}`
    const current = artifactsByLogicalId.get(logicalId)
    const isNativeVersion = Boolean(artifact.versionId && artifact.id === artifact.versionId)
    const currentIsNativeVersion = Boolean(current?.versionId && current.id === current.versionId)
    if (!current || (isNativeVersion && !currentIsNativeVersion)) {
      artifactsByLogicalId.set(logicalId, artifact)
    }
  }

  return Array.from(artifactsByLogicalId.values())
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

const isSafeVersionId = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)

const toResolvedMessageArtifact = (descriptor: ArtifactVersionDescriptor): MessageArtifact => ({
  id: descriptor.versionId,
  artifactId: descriptor.artifactId,
  versionId: descriptor.versionId,
  versionNumber: descriptor.versionNumber,
  kind: 'managed-file',
  path: createArtifactVersionLocator({
    projectId: descriptor.projectName,
    appSessionId: descriptor.sessionId,
    artifactId: descriptor.artifactId,
    versionId: descriptor.versionId
  }),
  name: descriptor.name,
  mimeType: descriptor.mimeType,
  size: descriptor.size,
  mtimeMs: descriptor.mtimeMs,
  sha256: descriptor.checksum,
  resolvedProjectId: descriptor.projectName,
  resolvedSessionId: descriptor.sessionId
})

// Historical branch snapshots deliberately omit session.artifacts. Resolve only the Version ids
// their copied messages reference, cache the results for this mount, and leave legacy identifiers
// on the existing session-metadata path.
const useHistoricalArtifactDescriptors = (
  activeSession: ChatSession | undefined
): ReadonlyMap<string, MessageArtifact | undefined> => {
  const resolvedRef = useRef<{
    sessionId: string | undefined
    artifactsByVersionId: Map<string, MessageArtifact | undefined>
  }>({ sessionId: undefined, artifactsByVersionId: new Map() })
  const [resolved, setResolved] = useState<{
    sessionId: string | undefined
    artifactsByVersionId: ReadonlyMap<string, MessageArtifact | undefined>
  }>({ sessionId: undefined, artifactsByVersionId: new Map() })
  const [retryToken, setRetryToken] = useState(0)
  const retriedVersionIdsRef = useRef(new Set<string>())
  const mountedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    const sessionId = activeSession?.id
    if (resolvedRef.current.sessionId !== sessionId) {
      resolvedRef.current = { sessionId, artifactsByVersionId: new Map() }
      retriedVersionIdsRef.current.clear()
      setResolved(resolvedRef.current)
    }
    if (!activeSession || typeof window.api?.artifacts?.resolveVersionDescriptors !== 'function') {
      return
    }

    const cache = resolvedRef.current.artifactsByVersionId
    const storedArtifactIds = new Set(
      (activeSession.artifacts ?? []).map((artifact) => artifact.id)
    )
    const unresolvedVersionIds = [
      ...new Set(activeSession.messages.flatMap((message) => message.artifactIds ?? []))
    ].filter(
      (versionId) =>
        !storedArtifactIds.has(versionId) && !cache.has(versionId) && isSafeVersionId(versionId)
    )
    if (unresolvedVersionIds.length === 0) return

    // Claim ids before the first await so a rerender/StrictMode pass cannot issue duplicate IPC.
    for (const versionId of unresolvedVersionIds) cache.set(versionId, undefined)

    void (async () => {
      for (
        let index = 0;
        index < unresolvedVersionIds.length;
        index += MAX_ARTIFACT_VERSION_DESCRIPTOR_IDS
      ) {
        const versionIds = unresolvedVersionIds.slice(
          index,
          index + MAX_ARTIFACT_VERSION_DESCRIPTOR_IDS
        )
        try {
          const descriptors = await window.api.artifacts.resolveVersionDescriptors({
            projectId: activeSession.projectId,
            appSessionId: activeSession.id,
            versionIds
          })
          for (const descriptor of descriptors) {
            cache.set(descriptor.versionId, toResolvedMessageArtifact(descriptor))
          }
        } catch {
          // Failed lookups are retryable; only a successful response can confirm a missing Version.
          let shouldRetry = false
          for (const versionId of versionIds) {
            cache.delete(versionId)
            if (!retriedVersionIdsRef.current.has(versionId)) {
              retriedVersionIdsRef.current.add(versionId)
              shouldRetry = true
            }
          }
          if (shouldRetry) {
            // A freshly bound child can render before its queued Session save establishes ownership
            // in main. Retry only after that persistence queue settles instead of racing a timer.
            await flushSessionPersistence()
            if (
              mountedRef.current &&
              resolvedRef.current.sessionId === sessionId &&
              resolvedRef.current.artifactsByVersionId === cache
            ) {
              setRetryToken((token) => token + 1)
            }
          }
        }
      }
      if (
        mountedRef.current &&
        resolvedRef.current.sessionId === sessionId &&
        resolvedRef.current.artifactsByVersionId === cache
      ) {
        setResolved({ sessionId, artifactsByVersionId: new Map(cache) })
      }
    })()
  }, [activeSession, retryToken])

  return resolved.sessionId === activeSession?.id ? resolved.artifactsByVersionId : new Map()
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
    <div className="px-4 pb-1 md:px-6">
      <div className="mx-auto w-full max-w-[56rem]">
        {/* Only "Go to transcript" navigates to the reviewer page; the card itself does not. */}
        <ReviewerCard review={review} onGoToTranscript={onGoToTranscript} onRerun={onRerun} />
      </div>
    </div>
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
  onSendEditedMessage,
  handoffLifecycleSource,
  onRetryHandoff
}: WorkspaceMessageScrollerProps): React.JSX.Element => {
  const currentSessionId = activeSession?.id
  const currentProjectId = activeSession?.projectId
  const historicalArtifactsByVersionId = useHistoricalArtifactDescriptors(activeSession)
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
  const collapsedActivityGroups =
    collapsedActivityGroupState.sessionId === currentSessionId
      ? collapsedActivityGroupState.groupIds
      : new Set<string>()
  const activityExpansionOverrides =
    activityExpansionOverrideState.sessionId === currentSessionId
      ? activityExpansionOverrideState.overrides
      : {}
  const conversationItems = useMemo(
    () =>
      groupConversationItems(
        createConversationItems(activeSession, handoffEvents),
        activeSession?.activityGroups
      ),
    [activeSession, handoffEvents]
  )
  // Assistant text can be split into several messages around tool calls. All fragments share the
  // prompt they respond to, but only the last visible fragment in that turn owns whole-turn metadata.
  // Legacy unlinked messages remain independent so older transcripts do not lose their timestamps.
  const assistantFooterMessageIds = useMemo(() => {
    const footerIds = new Set<string>()
    const footerIdByPromptMessageId = new Map<string, string>()

    for (const item of conversationItems) {
      if (item.type !== 'message' || item.message.role !== 'agent') continue

      const promptMessageId = item.message.responseToMessageId
      if (!promptMessageId) {
        footerIds.add(item.message.id)
        continue
      }

      const previousFooterId = footerIdByPromptMessageId.get(promptMessageId)
      if (previousFooterId) footerIds.delete(previousFooterId)
      footerIdByPromptMessageId.set(promptMessageId, item.message.id)
      footerIds.add(item.message.id)
    }

    return footerIds
  }, [conversationItems])
  const showAgentLoadingMessage = shouldShowAgentLoadingMessage(activeSession)
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
  const showMentionNotice = (message: string): void => {
    if (mentionNoticeTimerRef.current !== undefined) {
      window.clearTimeout(mentionNoticeTimerRef.current)
    }

    setMentionNotice(message)
    mentionNoticeTimerRef.current = window.setTimeout(() => {
      setMentionNotice(null)
      mentionNoticeTimerRef.current = undefined
    }, MENTION_NOTICE_TIMEOUT_MS)
  }

  // Routes a generated-file click to the preview workbench, scoped to the active session.
  const onPreviewArtifact = (artifact: MessageArtifact): void => {
    if (currentSessionId) previewArtifact(artifact, currentSessionId, currentProjectId)
  }

  // Routes a sent-message upload click to the preview workbench for the active session.
  const onPreviewUploadAttachment = (attachment: MessageUploadAttachment): void => {
    if (currentSessionId) {
      previewUploadAttachment(attachment, currentSessionId, activeSession?.projectId)
    }
  }

  // Opens an artifact mention in the preview panel, probing existence first so a stale link warns.
  const onPreviewMentionArtifact = async (part: ArtifactMentionPart): Promise<void> => {
    if (!currentSessionId) return
    if (part.source === 'linked-folder') {
      showMentionNotice('Linked-folder files are not available until the folder is connected.')
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
  }

  // Opens Settings on a skill mention's detail, warning instead when the skill no longer exists.
  const onOpenSkillMention = async (skillId: string, name: string): Promise<void> => {
    const detail = await window.api.settings.getSkillDetail(skillId).catch(() => null)

    if (!detail) {
      showMentionNotice(`Skill "${name}" is no longer available.`)
      return
    }

    useSettingsStore.getState().openSettingsToSkill(skillId)
  }

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
        model: useSettingsStore.getState().activeModel,
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
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-bg-10 to-bg-10/0"
          />
          <MessageScrollerViewport aria-label="Conversation">
            <MessageScrollerContent className="gap-0 px-4">
              <div className={conversationContentClassName}>
                {/* Messages and tool activities share one sorted transcript timeline. */}
                {conversationItems.map((item, itemIndex) => {
                  if (item.type === 'message') {
                    const artifacts =
                      activeSession && item.message.role !== 'user'
                        ? getMessageArtifacts(
                            activeSession,
                            item.message,
                            historicalArtifactsByVersionId
                          )
                        : []
                    // Jobs pre-assigned to this slot: each job appears in exactly one slot.
                    const jobsBeforeMessage = jobSlotsByItemIndex.get(itemIndex) ?? []
                    const graph = activeSession?.conversationGraph
                    const messageNode = graph?.messages.find(
                      (message) => message.id === item.message.id
                    )
                    const runtimeSegment = messageNode?.runtimeSegmentId
                      ? graph?.runtimeSegments.find(
                          (segment) => segment.id === messageNode.runtimeSegmentId
                        )
                      : undefined
                    // Legacy sessions synthesize this segment with a fallback framework. Keep only
                    // the session-level values that were actually persisted.
                    const synthesizedLegacyRuntime =
                      runtimeSegment?.id === `runtime-segment-${activeSession?.id}` &&
                      !activeSession?.agentFrameworkId
                    const runtimeIdentity = synthesizedLegacyRuntime
                      ? activeSession?.agentBackendId || activeSession?.agentModel
                        ? {
                            backendId: activeSession.agentBackendId,
                            model: activeSession.agentModel
                          }
                        : undefined
                      : runtimeSegment
                    const revisionRootMessageId = messageNode?.revisionRootMessageId
                    const revisions = revisionRootMessageId
                      ? (graph?.messages
                          .filter(
                            (message) =>
                              message.role === 'user' &&
                              message.revisionRootMessageId === revisionRootMessageId
                          )
                          .sort(
                            (left, right) =>
                              left.createdAt - right.createdAt || left.id.localeCompare(right.id)
                          ) ?? [])
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
                              .activateMessageBranch(
                                activeSession.id,
                                revision.introducedOnBranchId
                              )
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
                        item.message.role !== 'agent' ||
                        assistantFooterMessageIds.has(item.message.id),
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

                    return (
                      <div key={item.id}>
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
                        {item.message.role === 'user' ? (
                          <EditableWorkspaceMessageItem {...messageItemProps} />
                        ) : (
                          <WorkspaceMessageItem {...messageItemProps} canEditMessage={false} />
                        )}
                        {currentSessionId && item.message.role === 'agent' ? (
                          <WorkspaceMessageReview
                            projectId={currentProjectId}
                            sessionId={currentSessionId}
                            turnMessageId={item.message.id}
                            onGoToTranscript={handleGoToTranscript}
                            onRerun={handleRerunReview}
                          />
                        ) : null}
                      </div>
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

                  return (
                    <WorkspaceActivityGroup
                      key={item.id}
                      group={item}
                      isExpanded={!collapsedActivityGroups.has(item.id)}
                      onToggleGroup={toggleActivityGroup}
                      expansionOverrides={activityExpansionOverrides}
                      onToggleRow={toggleActivityRow}
                      jobsByActivityId={jobsByActivityId}
                      onOpenJobDetail={handleOpenJobDetail}
                    />
                  )
                })}

                {/* Render any remaining unbound completed jobs after all conversation items */}
                {trailingJobs.map((job) => (
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

                {showAgentLoadingMessage && activeSession ? (
                  <WorkspaceAgentLoadingRow sessionId={activeSession.id} />
                ) : null}
              </div>
            </MessageScrollerContent>
          </MessageScrollerViewport>

          <MessageScrollerButton className="z-10 border-border-200 bg-bg-000 shadow-card hover:bg-bg-200 data-[direction=end]:bottom-3" />

          {/* Transient warning shown when a mention target no longer resolves to a file or skill. */}
          {mentionNotice ? (
            <div
              role="status"
              className="pointer-events-none absolute inset-x-0 bottom-14 z-10 flex justify-center px-4"
            >
              <span className="rounded-full border border-border-200 bg-bg-000 px-3 py-1 text-[13px] text-text-100 shadow-card">
                {mentionNotice}
              </span>
            </div>
          ) : null}
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
  areSessionsEqualForTranscript(previous.activeSession, next.activeSession)

const WorkspaceMessageScroller = memo(
  WorkspaceMessageScrollerImpl,
  areWorkspaceMessageScrollerPropsEqual
)
WorkspaceMessageScroller.displayName = 'WorkspaceMessageScroller'

export { WorkspaceMessageScroller }
