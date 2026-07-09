import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport
} from '@/components/ui/message-scroller'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import type { ChatSession } from '@/stores/session-store'
import { useState } from 'react'

import { shouldShowAgentLoadingMessage } from './agent-loading-message'
import {
  createPreviewFileItemFromArtifact,
  createPreviewFileItemFromUpload
} from './preview-file-item'
import { WorkspaceActivityGroup } from './WorkspaceActivityGroup'
import { WorkspaceAgentLoadingRow } from './WorkspaceAgentLoadingRow'
import { WorkspaceMessageItem } from './WorkspaceMessageItem'
import { createConversationItems } from './workspace-conversation-items'
import { groupConversationItems } from './workspace-tool-activity-groups'
import type { ActivityExpansionOverrides } from './workspace-tool-activity-groups'

type WorkspaceMessageScrollerProps = {
  activeSession: ChatSession | undefined
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

// Owns transcript scrolling and session-scoped expansion state for activity groups.
const WorkspaceMessageScroller = ({
  activeSession
}: WorkspaceMessageScrollerProps): React.JSX.Element => {
  const currentSessionId = activeSession?.id
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

  // Routes a generated-file click to the preview workbench, scoped to the active session.
  const onPreviewArtifact = (artifact: MessageArtifact): void => {
    if (currentSessionId) previewArtifact(artifact, currentSessionId)
  }

  // Routes a sent-message upload click to the preview workbench for the active session.
  const onPreviewUploadAttachment = (attachment: MessageUploadAttachment): void => {
    if (currentSessionId) previewUploadAttachment(attachment, currentSessionId)
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

                  return (
                    <WorkspaceMessageItem
                      key={item.id}
                      message={item.message}
                      onPreviewArtifact={onPreviewArtifact}
                      onPreviewUploadAttachment={onPreviewUploadAttachment}
                      artifacts={artifacts}
                    />
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
      </MessageScroller>
    </MessageScrollerProvider>
  )
}

export { WorkspaceMessageScroller }
