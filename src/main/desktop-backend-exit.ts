import type { ChildProcess } from 'node:child_process'

// The web service lives in the launched Node backend (#3358). An HTTP shutdown stops the backend
// with exit code 0, and the desktop cannot outlive the backend it owns — quit the way the
// pre-#3358 in-process web service did. Client-initiated quits suppress onDisconnect upstream.
export const handleOwnedBackendDisconnect = (input: {
  child: ChildProcess
  error: Error
  updateCommitted: boolean
  onCleanExit: () => void
  onFailure: (error: Error) => void
}): void => {
  const { child } = input
  const onExit = (): void => {
    if (input.updateCommitted) return
    if (child.exitCode === 0) input.onCleanExit()
    else input.onFailure(input.error)
  }
  if (child.exitCode === null) child.once('exit', onExit)
  else onExit()
}
