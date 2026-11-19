export type NotebookKernelEpochOwnership = Readonly<{
  id: string
  processKey: string
}>

// The Aggregate only carries the original Main-owned reference to its control connection. It
// cannot inspect or create execution authority. This brand is erased and never enters a document.
export declare const notebookExecutionIntentReference: unique symbol
export type NotebookExecutionIntentReference = {
  readonly [notebookExecutionIntentReference]: true
}

export type NativeTransientViewImage = Readonly<{
  data: string
  mimeType: 'image/png' | 'image/jpeg'
  evidence?: never
}>

/** Tool results contain native image bytes or Vision evidence, never both. */
export type TransientViewImage =
  NativeTransientViewImage | Readonly<{ evidence: string; data?: never; mimeType?: never }>
