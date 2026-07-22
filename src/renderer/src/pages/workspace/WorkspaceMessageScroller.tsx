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
import { useReviewStore } from '@/stores/review-store'
import { useSettingsStore } from '@/stores/settings-store'
import type { ChatSession } from '@/stores/session-store'
import { useEffect, useRef, useState } from 'react'

import { shouldShowAgentLoadingMessage } from './agent-loading-message'
import {
  createPreviewFileItemFromArtifact,
  createPreviewFileItemFromMention,
  createPreviewFileItemFromUpload
} from './preview-file-item'
import { ReviewerCard } from '@/components/ReviewerCard'
import { WorkspaceActivityGroup } from './WorkspaceActivityGroup'
import { WorkspaceAgentLoadingRow } from './WorkspaceAgentLoadingRow'
import { WorkspaceMessageItem } from './WorkspaceMessageItem'
import type { ArtifactMentionPart } from './WorkspaceMessageItem'
import { createConversationItems } from './workspace-conversation-items'
import { groupConversationItems } from './workspace-tool-activity-groups'
import type { ActivityExpansionOverrides } from './workspace-tool-activity-groups'
import type { GoToTranscriptIntent, ReviewWithChecks } from '../../../../shared/reviewer'
import type { ComposerDoc } from './composer/composer-doc'

type WorkspaceMessageScrollerProps = {
  activeSession: ChatSession | undefined
  // Gates inline editing of sent user prompts; the handler resends the edited doc as a new turn.
  canEditMessage: boolean
  onSendEditedMessage: (doc: ComposerDoc) => void
}

type SessionScopedActivityGroupState = {
  sessionId: string | undefined
  groupIds: Set<string>
}

type SessionScopedActivityExpansionState = {
  sessionId: string | undefined
  overrides: ActivityExpansionOverrides
}

type MessageArtifact = NonNullable<ChatSession['artifacts']>[number]
type MessageUploadAttachment = NonNullable<ChatSession['messages'][number]['uploads']>[number]
const conversationContentClassName = 'relative mx-auto w-full max-w-4xl pb-[56px]'
// How long a "no longer available" mention notice stays visible before auto-dismissing.
const MENTION_NOTICE_TIMEOUT_MS = 3000

// Resolves a message's artifact ids against the session-level artifact metadata store.
const getMessageArtifacts = (
  session: ChatSession,
  message: ChatSession['messages'][number]
): MessageArtifact[] => {
  if (!message.artifactIds || !session.artifacts) return []

  const artifactsById = new Map(session.artifacts.map((artifact) => [artifact.id, artifact]))

  return message.artifactIds
    .map((artifactId) => artifactsById.get(artifactId))
    .filter((artifact): artifact is MessageArtifact => Boolean(artifact))
}

// Sends an app-managed generated file to the preview workbench instead of opening it locally.
const previewArtifact = (artifact: MessageArtifact, sessionId: string): void => {
  const previewItem = createPreviewFileItemFromArtifact(artifact, sessionId)

  // Generated files keep their artifact id so repeated clicks refresh the existing preview tab.
  if (previewItem) usePreviewWorkbenchStore.getState().upsertAndActivateItem(previewItem)
}

// Sends an app-managed uploaded file to the preview workbench.
const previewUploadAttachment = (attachment: MessageUploadAttachment, sessionId: string): void => {
  // Upload ids are namespaced away from artifact ids while preserving one tab per uploaded file.
  usePreviewWorkbenchStore
    .getState()
    .upsertAndActivateItem(createPreviewFileItemFromUpload(attachment, sessionId))
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

// Owns transcript scrolling and session-scoped expansion state for activity groups.
const WorkspaceMessageScroller = ({
  activeSession,
  canEditMessage,
  onSendEditedMessage
}: WorkspaceMessageScrollerProps): React.JSX.Element => {
  const currentSessionId = activeSession?.id
  const getReviewForTurn = useReviewStore((state) => state.getReviewForTurn)
  const loadReviewsForSession = useReviewStore((state) => state.loadReviewsForSession)

  // Load persisted reviews whenever the active session changes.
  useEffect(() => {
    if (currentSessionId) {
      void loadReviewsForSession(currentSessionId)
    }
  }, [currentSessionId, loadReviewsForSession])

  // Reload (which recomputes staleness against current artifact bytes) when the window regains focus.
  // An artifact edited outside the app while this session stays open would otherwise keep showing its
  // review as current until the user switched sessions away and back; a focus return is the natural
  // moment an out-of-app edit could have happened.
  useEffect(() => {
    if (!currentSessionId) return

    const onFocus = (): void => {
      void loadReviewsForSession(currentSessionId)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [currentSessionId, loadReviewsForSession])

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
  const conversationItems = groupConversationItems(createConversationItems(activeSession))
  const showAgentLoadingMessage = shouldShowAgentLoadingMessage(activeSession)

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
    if (currentSessionId) previewArtifact(artifact, currentSessionId)
  }

  // Routes a sent-message upload click to the preview workbench for the active session.
  const onPreviewUploadAttachment = (attachment: MessageUploadAttachment): void => {
    if (currentSessionId) previewUploadAttachment(attachment, currentSessionId)
  }

  // Opens an artifact mention in the preview panel, probing existence first so a stale link warns.
  const onPreviewMentionArtifact = async (part: ArtifactMentionPart): Promise<void> => {
    if (!currentSessionId) return

    const read =
      part.source === 'upload' ? window.api.uploads.readPreview : window.api.artifacts.readPreview

    try {
      await read({ path: part.path, maxBytes: 1, encoding: 'utf8' })
    } catch {
      showMentionNotice(`"${part.name}" is no longer available.`)
      return
    }

    usePreviewWorkbenchStore
      .getState()
      .upsertAndActivateItem(createPreviewFileItemFromMention(part, currentSessionId))
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
              {conversationItems.map((item) => {
                if (item.type === 'message') {
                  const artifacts =
                    activeSession && item.message.role !== 'user'
                      ? getMessageArtifacts(activeSession, item.message)
                      : []
                  // Look up any review for this agent message (its id is the turnMessageId).
                  const review =
                    currentSessionId && item.message.role === 'agent'
                      ? getReviewForTurn(currentSessionId, item.message.id)
                      : undefined

                  return (
                    <div key={item.id}>
                      <WorkspaceMessageItem
                        message={item.message}
                        onPreviewArtifact={onPreviewArtifact}
                        onPreviewUploadAttachment={onPreviewUploadAttachment}
                        onOpenSkillMention={onOpenSkillMention}
                        onPreviewMentionArtifact={onPreviewMentionArtifact}
                        canEditMessage={canEditMessage}
                        onSendEditedMessage={onSendEditedMessage}
                        artifacts={artifacts}
                      />
                      {review ? (
                        <div className="px-4 pb-1 md:px-6">
                          <div className="mx-auto w-full max-w-[56rem]">
                            {/* Only "Go to transcript" navigates to the reviewer page; the card itself does not. */}
                            <ReviewerCard
                              review={review}
                              onGoToTranscript={handleGoToTranscript}
                              onRerun={handleRerunReview}
                            />
                          </div>
                        </div>
                      ) : null}
                    </div>
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
                  />
                )
              })}

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
  )
}

export { WorkspaceMessageScroller }
