import { flushPreviewPersistence } from './preview-persistence/preview-persistence'
import { flushSessionPersistence } from './session-persistence/session-persistence'

// Electron can request a renderer flush after backend teardown. A local Web renderer has no
// BrowserWindow, so it persists its Session/Preview queues before invoking a data-root handoff RPC;
// the headless main process then owns producer teardown and the pointer transaction.
export const flushDataRootHandoffPersistence = async (): Promise<void> => {
  await flushSessionPersistence()
  await flushPreviewPersistence()
}
