export function installationRootForEntry(entryPath: string): string
export function protectInstallationStartup(
  entryPath: string,
  configRoot: string,
  stateRoot?: string
): {
  readonly identity: Readonly<{
    pid: number
    generation: string
    configRoot: string
    installationRoot: string
  }>
  isHeld(): boolean
  release(): void
}
