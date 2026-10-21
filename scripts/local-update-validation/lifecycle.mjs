/* eslint-disable @typescript-eslint/explicit-function-return-type */

// npm and a foreground terminal can deliver the same stop request more than once. Retain both
// handlers until the caller has finished its verification, source shutdown, and evidence writes.
export function installRunSignalHandlers(onStop) {
  let requested = false
  const stop = () => {
    if (requested) return
    requested = true
    onStop()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  return () => {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}
