import { writeFile } from 'node:fs/promises'

import type { ArtifactRepository } from '../artifacts/repository'
import type { KetcherStructureFormat } from '../../shared/ketcher'
import type { KetcherBroker } from './broker'

// The active turn's artifact run, resolved from the ACP runtime so open_sketcher can write its .ket into
// the same pending run (host.mcp calls carry no session context of their own).
export type KetcherRunContext = {
  projectName: string
  sessionId: string
  artifactSessionId: string
  runId: string
}

type KetcherServiceDeps = {
  broker: KetcherBroker
  repository: ArtifactRepository
  // Returns the active turn's run context, or undefined between turns (then open_sketcher errors).
  resolveRunContext: () => KetcherRunContext | undefined
  // Injectable for tests; defaults to fs.writeFile for the throttled tile-edit persistence path.
  writeFile?: (path: string, data: string) => Promise<void>
}

const STRUCTURE_FORMATS: KetcherStructureFormat[] = ['ket', 'molfile', 'smiles']

// Treats a missing file as the finalize-move case so save can recover the artifact's new path.
const isMissingFileError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 'ENOENT'

// Narrows an optional string argument, rejecting a present-but-wrong-typed value.
const optionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  return value
}

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required`)
  }
  return value
}

// Coerces the atoms/bonds arrays into integer index lists, rejecting non-numeric members.
const indexList = (value: unknown, field: string): number[] => {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of integers`)
  return value.map((item) => {
    const n = Number(item)
    if (!Number.isInteger(n)) throw new Error(`${field} must contain integers`)
    return n
  })
}

// Ensures a display filename is a plain, safe-looking .ket name (the repository does the final check).
const normalizeFilename = (filename: string | undefined, sequence: number): string => {
  const base = (filename ?? '').trim() || `sketch-${sequence}.ket`
  const withExt = base.toLowerCase().endsWith('.ket') ? base : `${base}.ket`
  // Keep only the last path segment so a stray slash can never widen the artifact write target.
  return withExt.split(/[\\/]/).pop() ?? `sketch-${sequence}.ket`
}

// Main-process host for the four interactive Ketcher tools. It writes the .ket artifact, mounts a live
// sketcher tile via the broker, and forwards set/highlight/get commands to that tile. Registered in the
// connector registry but dispatched here (not via ParserEngine) — see ConnectorService.callBundled.
export class KetcherService {
  // Tracks each open artifact's on-disk path so throttled tile edits can be persisted back to it.
  private readonly files = new Map<string, { path: string }>()
  private sequence = 0
  private readonly writeFileImpl: (path: string, data: string) => Promise<void>

  constructor(private readonly deps: KetcherServiceDeps) {
    this.writeFileImpl = deps.writeFile ?? ((path, data) => writeFile(path, data, 'utf8'))
  }

  async call(method: string, args: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'open_sketcher':
        return this.openSketcher(args)
      case 'set_structure':
        return this.setStructure(args)
      case 'highlight_atoms':
        return this.highlightAtoms(args)
      case 'get_structure':
        return this.getStructure(args)
      default:
        throw new Error(`unknown tool: ketcher/${method}`)
    }
  }

  // Persists a mounted tile's current structure back to its .ket artifact (best-effort, throttled).
  // After a turn ends the pending file is finalized into the message directory, so a stale tracked path
  // is re-resolved (and remembered) through the repository's pending->message recovery before writing.
  async save(artifactId: string, ket: string): Promise<void> {
    const entry = this.files.get(artifactId)
    if (!entry) return

    try {
      await this.writeFileImpl(entry.path, ket)
    } catch (error) {
      if (!isMissingFileError(error)) throw error

      const recovered = await this.deps.repository.resolveManagedFilePath({ path: entry.path })
      this.files.set(artifactId, { path: recovered })
      await this.writeFileImpl(recovered, ket)
    }
  }

  private async openSketcher(args: Record<string, unknown>): Promise<unknown> {
    const ket = optionalString(args.ket, 'ket')
    const molfile = optionalString(args.molfile, 'molfile')
    const rxn = optionalString(args.rxn, 'rxn')
    const smiles = optionalString(args.smiles, 'smiles')
    const seed = ket ?? molfile ?? rxn ?? smiles ?? ''

    const runContext = this.deps.resolveRunContext()
    if (!runContext) {
      throw new Error(
        'open_sketcher must be called during an active agent turn (no artifact run is active).'
      )
    }

    this.sequence += 1
    const filename = normalizeFilename(optionalString(args.filename, 'filename'), this.sequence)

    const artifact = await this.deps.repository.writePendingFile({
      projectName: runContext.projectName,
      sessionId: runContext.artifactSessionId,
      runId: runContext.runId,
      filename,
      source: { kind: 'inline', content: seed, encoding: 'utf8' }
    })

    this.files.set(artifact.id, { path: artifact.path })
    this.deps.broker.openTile({
      artifactId: artifact.id,
      sessionId: runContext.sessionId,
      path: artifact.path,
      name: filename,
      content: seed
    })
    // Wait for the tile to mount so a follow-up set/highlight/get finds it; the seed is already on disk,
    // so a slow mount is not fatal — the tool still returns the artifact id.
    await this.deps.broker.waitForMount(artifact.id).catch(() => undefined)

    return { artifact_id: artifact.id, filename }
  }

  private async setStructure(args: Record<string, unknown>): Promise<unknown> {
    const artifactId = requireString(args.artifact_id, 'artifact_id')
    const ket = optionalString(args.ket, 'ket')
    const molfile = optionalString(args.molfile, 'molfile')
    const smiles = optionalString(args.smiles, 'smiles')

    if (ket === undefined && molfile === undefined && smiles === undefined) {
      throw new Error('set_structure requires one of ket, molfile, or smiles')
    }

    await this.deps.broker.dispatch(artifactId, 'set', { ket, molfile, smiles })
    return { ok: true }
  }

  private async highlightAtoms(args: Record<string, unknown>): Promise<unknown> {
    const artifactId = requireString(args.artifact_id, 'artifact_id')
    const atoms = indexList(args.atoms, 'atoms')
    const bonds = args.bonds === undefined ? undefined : indexList(args.bonds, 'bonds')
    const color = optionalString(args.color, 'color')

    await this.deps.broker.dispatch(artifactId, 'highlight', { atoms, bonds, color })
    return { ok: true }
  }

  private async getStructure(args: Record<string, unknown>): Promise<unknown> {
    const artifactId = requireString(args.artifact_id, 'artifact_id')
    const format = (optionalString(args.format, 'format') ?? 'ket') as KetcherStructureFormat
    if (!STRUCTURE_FORMATS.includes(format)) {
      throw new Error(`format must be one of ${STRUCTURE_FORMATS.join(', ')}`)
    }

    const result = await this.deps.broker.dispatch(artifactId, 'get', { format })
    return { artifact_id: artifactId, format, structure: String(result ?? '') }
  }
}
