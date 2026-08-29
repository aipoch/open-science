import { drainWorkspaceRuntimeEventsForPersistence } from './acp/useWorkspaceAgentRuntime'
import { flushPreviewPersistence } from './preview-persistence/preview-persistence'
import { flushSessionPersistence } from './session-persistence/session-persistence'

// Electron can request a renderer flush after backend teardown. A local Web renderer has no
// BrowserWindow, so it drains queued runtime events and persists its Session/Preview queues before
// invoking a data-root handoff RPC; main then owns producer teardown and the pointer transaction.
export const flushDataRootHandoffPersistence = async (): Promise<void> => {
  await drainWorkspaceRuntimeEventsForPersistence()
  await flushSessionPersistence()
  await flushPreviewPersistence()
}
