// Shared IPC contracts for the interactive Ketcher sketcher: the main-process tool host drives a live
// renderer tile over these payloads, and the tile replies through the same channels.

export type KetcherStructureFormat = 'ket' | 'molfile' | 'smiles'

// One structure fill: exactly one of the three formats is provided by the caller.
export type KetcherSetPayload = { ket?: string; molfile?: string; smiles?: string }

// Atom (and optional bond) highlight applied to the mounted canvas.
export type KetcherHighlightPayload = { atoms: number[]; bonds?: number[]; color?: string }

// Structure read-back request; the reply carries the serialized structure string.
export type KetcherGetPayload = { format?: KetcherStructureFormat }

export type KetcherCommandOp = 'set' | 'highlight' | 'get'
export type KetcherCommandPayload = KetcherSetPayload | KetcherHighlightPayload | KetcherGetPayload

// main -> renderer: one imperative command addressed to a mounted tile, awaiting a reply.
export type KetcherCommand = {
  requestId: string
  artifactId: string
  op: KetcherCommandOp
  payload: KetcherCommandPayload
}

// renderer -> main: the tile's answer to a command (result for `get`, error on failure).
export type KetcherReply = { requestId: string; result?: unknown; error?: string }

// main -> renderer: open (or refocus) an editable sketcher tile for a freshly written artifact.
export type KetcherOpenTile = {
  artifactId: string
  sessionId: string
  path: string
  name: string
  content: string
}

// renderer -> main: a tile announcing that it mounted or unmounted for an artifact.
export type KetcherMountNotice = { artifactId: string }

// renderer -> main: throttled persistence of a tile's current structure back to its .ket artifact.
export type KetcherSaveRequest = { artifactId: string; ket: string }
