/* global WorkerGlobalScope: readonly */
// PDF.js 5.4 can reject setupDoc after Terminate; only this expected worker cancellation is handled.
if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  let terminating = false
  globalThis.addEventListener('message', (event) => {
    if (event.data?.action === 'Terminate') terminating = true
  })
  globalThis.addEventListener('unhandledrejection', (event) => {
    if (
      terminating &&
      event.reason instanceof Error &&
      event.reason.message === 'Worker was terminated'
    )
      event.preventDefault()
  })
}
