import type { NotebookWorkingFile } from '../../shared/notebook'

export type NotebookKernelEpochOwnership = Readonly<{
  id: string
  processKey: string
}>

export type TransientViewImage = Readonly<{
  data: string
  mimeType: 'image/png' | 'image/jpeg'
}>

/** Main-only evidence from the observer that froze this exact file generation. */
export type FrozenNestedWorkingFile = Readonly<{
  activityId: string
  evidenceChecksum: string
  file: Readonly<NotebookWorkingFile>
  physicalPath: string
  dev: number
  ino: number
  ctimeMs: number
}>

export type NestedWorkingFileReader = Readonly<{
  read(): readonly FrozenNestedWorkingFile[]
}>
