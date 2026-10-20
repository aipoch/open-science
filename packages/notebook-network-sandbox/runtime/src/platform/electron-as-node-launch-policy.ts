/**
 * Electron's Node bootstrap opens the Windows NUL device while initializing stdio. An
 * AppContainer may deny that device even though the rest of the process launch is correctly
 * contained. Electron exposes --no-stdio-init for this case.
 *
 * Keep the decision at the launch seam: callers describe the launch intent, and this policy only
 * changes a restricted Windows Electron-as-Node invocation. In particular, the environment marker
 * is deliberately not added or removed here; it remains the caller's explicit Electron contract.
 */

const ELECTRON_NO_STDIO_INIT = '--no-stdio-init'

type ElectronAsNodeLaunchIntent = Readonly<{
  platform: NodeJS.Platform
  restricted: boolean
  electronAsNode: boolean
  args: readonly string[]
}>

const applyElectronAsNodeLaunchPolicy = (intent: ElectronAsNodeLaunchIntent): readonly string[] => {
  if (
    intent.platform !== 'win32' ||
    !intent.restricted ||
    !intent.electronAsNode ||
    intent.args.includes(ELECTRON_NO_STDIO_INIT)
  ) {
    return [...intent.args]
  }
  return [ELECTRON_NO_STDIO_INIT, ...intent.args]
}

export { ELECTRON_NO_STDIO_INIT, applyElectronAsNodeLaunchPolicy }
export type { ElectronAsNodeLaunchIntent }
