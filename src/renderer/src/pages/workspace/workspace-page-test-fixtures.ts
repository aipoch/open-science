import { createInitialReviewState, useReviewStore } from '@/stores/review-store'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import type { ProviderView } from '../../../../shared/settings'

const TEST_PROVIDER: ProviderView = {
  id: 'test-provider',
  type: 'custom',
  name: 'Test Provider',
  supportsImageInput: false,
  models: ['test-model'],
  hasKey: true,
  needsKey: false
}

const workspaceReviewSessionKey = (projectId: string, sessionId: string): string =>
  `${projectId}\0${sessionId}`

const setDefaultWorkspaceAgentSettings = (): void => {
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    isLoaded: true,
    activeProviderId: TEST_PROVIDER.id,
    activeModel: TEST_PROVIDER.models[0],
    providers: [TEST_PROVIDER]
  })
}

// WorkspacePage tests mock ConversationPanel, so WorkspaceMessageScroller never loads review history.
// Mark the selected Session as hydrated so turn admission is not fail-closed for unrelated send paths.
const markWorkspaceReviewHistoryLoaded = (
  ...sessions: ReadonlyArray<{ projectId: string; sessionId: string }>
): void => {
  useReviewStore.setState({
    ...createInitialReviewState(),
    loadedReviewSessions: Object.fromEntries(
      sessions.map(({ projectId, sessionId }) => [
        workspaceReviewSessionKey(projectId, sessionId),
        true
      ])
    )
  })
}

export { markWorkspaceReviewHistoryLoaded, setDefaultWorkspaceAgentSettings }
