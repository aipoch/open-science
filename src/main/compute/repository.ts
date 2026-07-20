import type { ComputeHost as PrismaComputeHost, PrismaClient } from '@prisma/client'

import type {
  ComputeHost,
  ComputeHostShape,
  CreateComputeHostRequest,
  DetailsAuthor,
  ProbeResult,
  SshOverrides
} from '../../shared/compute'
import { computeProviderId, DETAILS_DOC_MAX_LENGTH } from '../../shared/compute'

// Only the computeHost delegate is needed; typing to this subset keeps the repository unit-testable
// with a lightweight mock instead of a real (engine-backed) PrismaClient (aligns with the reviewer and
// projects repositories, per design.md §2).
type ComputeHostClient = Pick<PrismaClient, 'computeHost'>

// Resolves the Prisma client on demand so a failed initialization is not held forever (see
// projects/repository.ts).
type ComputeHostClientProvider = () => Promise<ComputeHostClient>

// JSON columns are parsed defensively: a corrupt value degrades to undefined rather than throwing, so
// one bad row cannot break loading the whole host list.
const parseJson = <T>(value: string | null): T | undefined => {
  if (value === null) return undefined
  try {
    return JSON.parse(value) as T
  } catch {
    return undefined
  }
}

// Narrows the free-text shape column back to the domain union, defaulting unknown values to
// 'direct_ssh' so a corrupt row still renders as a plain host rather than crashing.
const asShape = (value: string): ComputeHostShape =>
  value === 'scheduler_cluster' || value === 'bridge_runner' || value === 'direct_ssh'
    ? value
    : 'direct_ssh'

const asAuthor = (value: string | null): DetailsAuthor | undefined =>
  value === 'user' || value === 'agent' ? value : undefined

// Maps a Prisma row (JSON strings + DateTime + nullable columns) into the epoch-ms domain shape shared
// with the renderer.
const toHost = (row: PrismaComputeHost): ComputeHost => ({
  id: row.id,
  providerId: row.providerId,
  displayName: row.displayName,
  shape: asShape(row.shape),
  sshAlias: row.sshAlias,
  sshOverrides: parseJson<SshOverrides>(row.sshOverrides),
  scratchRoot: row.scratchRoot ?? undefined,
  scratchPinned: row.scratchPinned,
  concurrencyLimit: row.concurrencyLimit ?? undefined,
  probeResult: parseJson<ProbeResult>(row.probeResult),
  detailsDoc: row.detailsDoc,
  detailsUpdatedAt: row.detailsUpdatedAt?.getTime(),
  detailsUpdatedBy: asAuthor(row.detailsUpdatedBy),
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime()
})

// Drops undefined/empty fields so an empty overrides object is stored as null (not "{}"). Security:
// only user/port/identityFile are ever serialized here — never a credential or key (design.md §1).
const serializeOverrides = (overrides: SshOverrides | undefined): string | null => {
  if (!overrides) return null
  const clean: SshOverrides = {}
  if (overrides.user?.trim()) clean.user = overrides.user.trim()
  if (typeof overrides.port === 'number' && Number.isFinite(overrides.port)) {
    clean.port = overrides.port
  }
  if (overrides.identityFile?.trim()) clean.identityFile = overrides.identityFile.trim()
  return Object.keys(clean).length === 0 ? null : JSON.stringify(clean)
}

// Owns ComputeHost reads/writes. The client is resolved lazily per call so schema-ensure failures can
// recover (see projects/repository.ts). Phase 1 (issue 01): create / list / get / delete; issue 02
// adds updateProbeResult and updateScratchRoot for probe persistence.
class ComputeHostRepository {
  constructor(private readonly getClient: ComputeHostClientProvider) {}

  // Lists hosts newest-first for the Compute list view.
  async list(): Promise<ComputeHost[]> {
    const client = await this.getClient()
    const rows = await client.computeHost.findMany({ orderBy: { createdAt: 'desc' } })

    return rows.map(toHost)
  }

  // Returns a single host by its provider id ("ssh:<alias>") or null when it no longer exists.
  async get(providerId: string): Promise<ComputeHost | null> {
    const client = await this.getClient()
    const row = await client.computeHost.findUnique({ where: { providerId } })

    return row ? toHost(row) : null
  }

  // Creates a host record. Validates the alias, the 32 KiB details cap, and rejects a duplicate
  // provider_id with a readable error before inserting. No SSH connection is made in Phase 1.
  async create(request: CreateComputeHostRequest): Promise<ComputeHost> {
    const alias = request.sshAlias.trim()
    if (!alias) {
      throw new Error('An SSH host alias is required.')
    }

    const detailsDoc = request.detailsDoc ?? ''
    if (detailsDoc.length > DETAILS_DOC_MAX_LENGTH) {
      throw new Error(
        `Details must be ${DETAILS_DOC_MAX_LENGTH} characters or fewer (got ${detailsDoc.length}).`
      )
    }

    const providerId = computeProviderId(alias)

    const client = await this.getClient()

    // Pre-check for a readable duplicate error rather than surfacing a raw unique-constraint failure.
    // The DB @unique index is still the authoritative guard against a race.
    const existing = await client.computeHost.findUnique({ where: { providerId } })
    if (existing) {
      throw new Error(`A host with alias "${alias}" is already registered.`)
    }

    const displayName = request.displayName?.trim() || alias
    // A seeded details doc is authored by the user editing the Add form.
    const hasDetails = detailsDoc.length > 0

    const row = await client.computeHost.create({
      data: {
        providerId,
        displayName,
        sshAlias: alias,
        sshOverrides: serializeOverrides(request.sshOverrides),
        detailsDoc,
        detailsUpdatedBy: hasDetails ? 'user' : null,
        detailsUpdatedAt: hasDetails ? new Date() : null
      }
    })

    return toHost(row)
  }

  // Removes a host row by provider id.
  async delete(providerId: string): Promise<void> {
    const client = await this.getClient()

    await client.computeHost.delete({ where: { providerId } })
  }

  // Writes the structured probe snapshot and inferred shape. Never touches detailsDoc (design.md §4).
  async updateProbeResult(
    providerId: string,
    result: ProbeResult,
    shape: ComputeHostShape
  ): Promise<void> {
    const client = await this.getClient()

    await client.computeHost.update({
      where: { providerId },
      data: {
        probeResult: JSON.stringify(result),
        shape
      }
    })
  }

  // Updates scratchRoot when the probe reads $SCRATCH and scratchPinned is false. Probe callers
  // must check scratchPinned before calling (ComputeService.probe does this).
  async updateScratchRoot(providerId: string, scratchRoot: string): Promise<void> {
    const client = await this.getClient()

    await client.computeHost.update({
      where: { providerId },
      data: { scratchRoot }
    })
  }
}

export { ComputeHostRepository, toHost }
export type { ComputeHostClient, ComputeHostClientProvider }
