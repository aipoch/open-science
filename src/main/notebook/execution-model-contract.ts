export type NotebookKernelEpochOwnership = Readonly<{
  id: string
  processKey: string
}>

export type TransientViewImage = Readonly<{
  data: string
  mimeType: 'image/png' | 'image/jpeg'
}>
