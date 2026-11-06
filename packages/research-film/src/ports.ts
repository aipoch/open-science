/** Host-owned installed assets; the package never downloads or removes them. */
export type ModelRevision = Readonly<{
  revision: string
  assets: readonly Readonly<{ file: string; url: string; size: number; sha256: string }>[]
}>
export type ModelLease = {
  revision: string
  assets: readonly { file: string; path: string }[]
  release(): void
}
export type ExportModelSnapshot = { availability: string; installedRevision?: string }
export type ExportModelPort<T extends ExportModelSnapshot = ExportModelSnapshot> = {
  getSnapshot(): Promise<T>
  acquireUse(): Promise<ModelLease>
}

export type VideoEncoderPaths = { encoderPath: string; probePath: string }
