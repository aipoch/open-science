import type { App } from 'electron'

import type { AcpRuntime } from './runtime'

// Kills the agent child when the app is actually quitting so no orphaned Claude agent process outlives
// the window — an orphan would keep its network connection alive after the app is gone. `will-quit`
// (not `before-quit`) fires only once the quit is committed, so a quit the migration guard cancels —
// asking the user to keep waiting — does not tear the agent down early. The runtime shutdown is
// synchronous because Electron does not await quit-event handlers.
export const installAgentShutdownGuard = (
  app: Pick<App, 'on'>,
  runtime: Pick<AcpRuntime, 'shutdown'>
): void => {
  app.on('will-quit', () => {
    runtime.shutdown()
  })
}
