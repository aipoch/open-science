// A failed stop is an execution-integrity failure, not an ordinary user-code error or cancellation.
// Keep its identity across in-process Notebook, ACP, and Task boundaries; never persist the instance.
export class NotebookExecutionStopError extends Error {
  constructor(message = 'Notebook process tree could not be stopped.', options?: ErrorOptions) {
    super(message, options)
    this.name = 'NotebookExecutionStopError'
  }
}
