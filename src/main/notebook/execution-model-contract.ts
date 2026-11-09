export type NotebookKernelEpochOwnership = Readonly<{
  id: string
  processKey: string
}>

export type NativeTransientViewImage = Readonly<{
  data: string
  mimeType: 'image/png' | 'image/jpeg'
  evidence?: never
}>

/** Tool results contain native image bytes or Vision evidence, never both. */
export type TransientViewImage =
  NativeTransientViewImage | Readonly<{ evidence: string; data?: never; mimeType?: never }>
