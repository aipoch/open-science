import type {
  KetcherCommand,
  KetcherHighlightPayload,
  KetcherSetPayload,
  KetcherStructureFormat
} from '../../../../shared/ketcher'

// Imperative handle a mounted KetcherTile exposes so the main-process tool host can drive its canvas.
export type KetcherTileHandle = {
  setStructure: (payload: KetcherSetPayload) => Promise<void>
  highlight: (payload: KetcherHighlightPayload) => Promise<void>
  getStructure: (format: KetcherStructureFormat) => Promise<string>
}

// Live tiles keyed by artifact id. Only mounted tiles are here, so a missing entry means "not mounted".
const tiles = new Map<string, KetcherTileHandle>()

// Registers a mounted tile and tells main so post-mount tools (set/highlight/get) can target it.
export const registerKetcherTile = (artifactId: string, handle: KetcherTileHandle): void => {
  tiles.set(artifactId, handle)
  window.api.ketcher.notifyMounted({ artifactId })
}

// Deregisters an unmounting tile and tells main so later commands fail fast with "tile not mounted".
export const unregisterKetcherTile = (artifactId: string): void => {
  tiles.delete(artifactId)
  window.api.ketcher.notifyUnmounted({ artifactId })
}

// Applies one command to the addressed tile and returns the value main should reply with (get only).
const runCommand = async (command: KetcherCommand): Promise<unknown> => {
  const handle = tiles.get(command.artifactId)

  if (!handle) throw new Error(`Ketcher tile not mounted: ${command.artifactId}`)

  if (command.op === 'set') {
    await handle.setStructure(command.payload as KetcherSetPayload)
    return undefined
  }
  if (command.op === 'highlight') {
    await handle.highlight(command.payload as KetcherHighlightPayload)
    return undefined
  }

  const format = (command.payload as { format?: KetcherStructureFormat }).format ?? 'ket'
  return handle.getStructure(format)
}

// Installs the single main->renderer command listener that dispatches to tiles and replies. Returns an
// unsubscribe so the owning effect can tear it down.
export const installKetcherCommandBridge = (): (() => void) =>
  window.api.ketcher.onCommand((command) => {
    void runCommand(command)
      .then((result) => window.api.ketcher.reply({ requestId: command.requestId, result }))
      .catch((error: unknown) =>
        window.api.ketcher.reply({
          requestId: command.requestId,
          error: error instanceof Error ? error.message : String(error)
        })
      )
  })
