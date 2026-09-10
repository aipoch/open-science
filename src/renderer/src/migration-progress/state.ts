// This surface deliberately has no business application API or storage dependency.
export type MigrationProgressState = {
  phase: string
  path?: string
  completed?: number
  total?: number
  startedAt: number
  updatedAt: number
  error?: string
  locale?: string
}
export type MigrationProgressBridge = {
  getState: () => Promise<MigrationProgressState>
  subscribe: (listener: (state: MigrationProgressState) => void) => () => void
  painted: () => void
  close: () => void
  copyDiagnostics: () => Promise<void>
}
declare global {
  interface Window {
    migrationProgress: MigrationProgressBridge
  }
}
