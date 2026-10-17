import { createHash } from 'node:crypto'
import type { NotebookRunInputFile } from '../../shared/notebook'
import type { HostArtifactCatalogItem } from '../../shared/project-files'
import {
  sessionPackageRequestSchema,
  type SessionPackageManifest,
  type SessionPackageReceipt
} from '../../shared/session-package'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { ImmutableInputAuthority } from '../immutable-input-authority'
import type { HostArtifactCatalog } from './host-artifacts-service'
import type {
  ResearchMaterialAuthority,
  ResearchMaterialSource,
  ResearchMaterialVersion
} from './research-materials'

export type ResearchPackageMaterialOrigin = {
  receiptIdentity: Pick<SessionPackageReceipt, 'importId' | 'manifestChecksum'>
  sourceManifest: SessionPackageManifest
  identities: Record<string, string>
  files: SessionPackageReceipt['files']
}
export type ResearchMaterialAuthorityDependencies = {
  catalog: HostArtifactCatalog
  inputAuthority: Pick<ImmutableInputAuthority, 'resolveVersion' | 'openContent'>
  readSession(projectId: string, sessionId: string): Promise<PersistedChatSession | undefined>
  // Bind SessionPackageService.readOrigin: it verifies retained manifest/records/receipt integrity.
  readOrigin?(request: {
    projectId: string
    sessionId: string
  }): Promise<ResearchPackageMaterialOrigin>
}
export type InspectResearchMaterialAuthorityRequest = {
  projectId: string
  sourceSessionId: string
  sourceImportId: string
  expectedSourceIdentity?: string
  signal?: AbortSignal
}

export type CreateResearchMaterialAuthorityRequest = {
  projectId: string
  sourceSessionId: string
  targetSessionId: string
  // Explicit historical versions supplement ordinary-session discovery, never widen its scope.
  versionIds?: string[]
  expectedSourceIdentity?: string
  signal?: AbortSignal
}

const MAX_EXPLICIT_VERSIONS = 1000
const MAX_CANDIDATE_IDENTITIES = 20_000
const MAX_MATERIAL_VERSIONS = 10_000
const digest = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex')
const reject = (message: string): never => {
  throw new Error(`Research material authority: ${message}`)
}

const sourceIdentity = (session: PersistedChatSession): string => {
  const origin = session.packageOrigin ?? session.forkOrigin
  return JSON.stringify([
    session.projectId,
    session.id,
    session.createdAt,
    session.packageOrigin ? 'import' : session.forkOrigin ? 'fork' : 'ordinary',
    origin?.importId,
    origin?.manifestChecksum,
    origin?.sourceProjectId,
    origin?.sourceSessionId
  ])
}

const readSourceAndTarget = async (
  dependencies: ResearchMaterialAuthorityDependencies,
  request: CreateResearchMaterialAuthorityRequest
): Promise<PersistedChatSession> => {
  request.signal?.throwIfAborted()
  const [source, target] = await Promise.all([
    dependencies.readSession(request.projectId, request.sourceSessionId),
    dependencies.readSession(request.projectId, request.targetSessionId)
  ])
  if (
    !source ||
    source.projectId !== request.projectId ||
    source.id !== request.sourceSessionId ||
    source.archivedAt !== undefined
  )
    return reject('the selected source is unavailable.')
  if (
    !target ||
    target.projectId !== request.projectId ||
    target.id !== request.targetSessionId ||
    target.packageOrigin ||
    target.archivedAt !== undefined
  )
    reject('the receiving Session is unavailable or read-only.')
  request.signal?.throwIfAborted()
  return source
}

// Main-only adapter. Project catalog rows are candidates, not authority: ordinary sessions admit
// only their own versions; imports admit only payloads proven by their verified retained receipt.
// A fork additionally admits its own new versions, but never unrelated Project files or new files
// in retained upstream Session scopes. Reading focus, UI membership and names grant no authority.
export const createResearchMaterialAuthority = async (
  dependencies: ResearchMaterialAuthorityDependencies,
  options: CreateResearchMaterialAuthorityRequest
): Promise<ResearchMaterialAuthority> => {
  sessionPackageRequestSchema.parse({
    projectId: options.projectId,
    sessionId: options.targetSessionId
  })
  const request = { ...structuredClone({ ...options, signal: undefined }), signal: options.signal }
  return buildResearchMaterialAuthority(dependencies, request, () =>
    readSourceAndTarget(dependencies, request)
  )
}

/** Source-only imported research discovery. It shares closure admission with execution without
 * minting a writable Session or bypassing createResearchMaterialAuthority's target check. */
export const createResearchMaterialInspectionAuthority = async (
  dependencies: ResearchMaterialAuthorityDependencies,
  options: InspectResearchMaterialAuthorityRequest
): Promise<ResearchMaterialAuthority> => {
  const request = { ...structuredClone({ ...options, signal: undefined }), signal: options.signal }
  if (!request.sourceImportId || request.sourceImportId.length > 512)
    reject('the selected import identity is invalid.')
  return buildResearchMaterialAuthority(dependencies, request, async () => {
    request.signal?.throwIfAborted()
    const source = await dependencies.readSession(request.projectId, request.sourceSessionId)
    if (
      !source ||
      source.projectId !== request.projectId ||
      source.id !== request.sourceSessionId ||
      source.archivedAt !== undefined ||
      source.packageOrigin?.importId !== request.sourceImportId
    )
      return reject('the selected imported source is unavailable or changed.')
    request.signal?.throwIfAborted()
    return source
  })
}

const buildResearchMaterialAuthority = async (
  dependencies: ResearchMaterialAuthorityDependencies,
  request: Omit<CreateResearchMaterialAuthorityRequest, 'targetSessionId'>,
  readCurrentSource: () => Promise<PersistedChatSession>
): Promise<ResearchMaterialAuthority> => {
  sessionPackageRequestSchema.parse({
    projectId: request.projectId,
    sessionId: request.sourceSessionId
  })
  if (
    request.versionIds &&
    (!Array.isArray(request.versionIds) ||
      request.versionIds.length > MAX_EXPLICIT_VERSIONS ||
      request.versionIds.some((id) => typeof id !== 'string' || !id || id.length > 512) ||
      new Set(request.versionIds).size !== request.versionIds.length)
  )
    reject('invalid or excessive explicit Version selection.')
  const source = structuredClone(await readCurrentSource())
  const initialIdentity = sourceIdentity(source)
  const assertCurrent = async (signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted()
    if (sourceIdentity(await readCurrentSource()) !== initialIdentity)
      reject('the selected source identity changed; select its materials again.')
    signal?.throwIfAborted()
  }
  let origin: ResearchPackageMaterialOrigin | undefined
  if (source.packageOrigin || source.forkOrigin) {
    if (!dependencies.readOrigin) return reject('verified package closure is unavailable.')
    origin = structuredClone(
      await dependencies.readOrigin({ projectId: source.projectId, sessionId: source.id })
    )
    const receipt = source.packageOrigin ?? source.forkOrigin!
    if (
      origin.receiptIdentity?.importId !== receipt.importId ||
      origin.receiptIdentity?.manifestChecksum !== receipt.manifestChecksum ||
      origin.sourceManifest.source.projectId !== receipt.sourceProjectId ||
      origin.sourceManifest.source.sessionId !== receipt.sourceSessionId ||
      origin.identities[receipt.sourceProjectId] !== source.projectId ||
      origin.identities[receipt.sourceSessionId] !== source.id
    )
      reject('package closure does not belong to the selected source.')
  }
  const mappedIds = new Set(origin ? Object.values(origin.identities) : [])
  if (mappedIds.size > MAX_CANDIDATE_IDENTITIES)
    reject('package identity discovery limit exceeded.')
  const included = new Map<
    string,
    { checksum: string; sourceSize: number; sourceChecksum: string }
  >()
  if (origin) {
    const excluded = new Set(origin.sourceManifest.excludedFiles.map((row) => row.storageKey))
    const inventory = new Map(
      origin.sourceManifest.inventory
        .filter((row) => row.kind === 'file' && row.storageKey)
        .map((row) => [row.storageKey!, row])
    )
    for (const file of origin.files) {
      const declared = inventory.get(file.sourceStorageKey)
      if (
        excluded.has(file.sourceStorageKey) ||
        !declared ||
        declared.checksum !== file.sourceChecksum
      )
        continue
      if (included.has(file.localStorageKey)) reject('package payload identity is ambiguous.')
      included.set(file.localStorageKey, {
        checksum: file.localChecksum,
        sourceSize: declared.sizeBytes,
        sourceChecksum: file.sourceChecksum
      })
    }
  }
  const latest = source.packageOrigin
    ? []
    : await dependencies.catalog.readHostArtifactCatalog({ projectId: request.projectId })
  const candidates = new Set([
    ...latest
      .filter((row) => row.projectId === source.projectId && row.sessionId === source.id)
      .map((row) => row.versionId),
    ...mappedIds,
    ...(request.versionIds ?? [])
  ])
  if (candidates.size > MAX_CANDIDATE_IDENTITIES) reject('Version discovery limit exceeded.')
  const inputs = new Map<string, NotebookRunInputFile>()
  const metadata = new Map<string, Omit<ResearchMaterialVersion, 'sourceIdentity'>>()
  const ids = [...candidates].sort()
  let next = 0
  let stopped: unknown
  const worker = async (): Promise<void> => {
    while (next < ids.length && stopped === undefined) {
      const id = ids[next++]
      try {
        request.signal?.throwIfAborted()
        const rows = await dependencies.catalog.readHostArtifactCatalog({
          projectId: source.projectId,
          versionId: id
        })
        if (rows.length > 1) reject('Version identity is ambiguous.')
        const row = rows[0]
        if (!row) continue // The receipt also remaps messages, runs and other non-file identities.
        if (row.projectId !== source.projectId || row.versionId !== id)
          reject('the catalog returned another Project or Version.')
        const ownNewVersion =
          row.sessionId === source.id && !source.packageOrigin && !mappedIds.has(id)
        if (!ownNewVersion && !mappedIds.has(id)) continue
        const input = await dependencies.inputAuthority.resolveVersion({
          projectId: source.projectId,
          sourceKind: row.source === 'artifact' ? 'artifact-version' : 'upload-version',
          inputFileVersionId: row.versionId,
          expectedSourceFileId: row.sourceFileId
        })
        if (!input) continue
        assertCatalogIdentity(row, input)
        const payload = included.get(input.storageKey)
        if (
          !ownNewVersion &&
          (!payload ||
            payload.checksum !== input.checksum ||
            (payload.sourceChecksum === payload.checksum && payload.sourceSize !== input.sizeBytes))
        )
          continue
        if (metadata.size >= MAX_MATERIAL_VERSIONS) reject('material Version limit exceeded.')
        inputs.set(id, structuredClone(input))
        metadata.set(id, {
          versionId: id,
          filename: row.filename,
          sha256: input.checksum,
          sizeBytes: input.sizeBytes
        })
      } catch (error) {
        stopped = error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, ids.length) }, worker))
  if (stopped !== undefined) throw stopped
  for (const id of request.versionIds ?? [])
    if (!metadata.has(id)) reject('a selected Version is unavailable or outside this research.')
  await assertCurrent()
  const versions = [...metadata.values()].sort((left, right) =>
    left.versionId.localeCompare(right.versionId)
  )
  const identity = `research-materials:${digest(
    JSON.stringify({
      source: initialIdentity,
      versions: versions.map(({ versionId, sha256, sizeBytes }) => [versionId, sha256, sizeBytes])
    })
  )}`
  if (request.expectedSourceIdentity && request.expectedSourceIdentity !== identity)
    reject('the selected material snapshot changed; select its materials again.')
  const materialSource: ResearchMaterialSource = {
    projectId: source.projectId,
    sessionId: source.id,
    title: source.title,
    identity
  }
  return {
    source: materialSource,
    versions: versions.map((version) => ({ ...version, sourceIdentity: identity })),
    readVersion: async (versionId, { maxBytes, signal }) => {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return reject('invalid read byte limit.')
      await assertCurrent(signal)
      const input = inputs.get(versionId)
      if (!input) return reject('the Version is outside the frozen material selection.')
      if (input.sizeBytes > maxBytes) return reject('material exceeds the read byte limit.')
      const lease = await dependencies.inputAuthority.openContent(input)
      try {
        if (lease.size !== input.sizeBytes) reject('material size changed.')
        const chunks: Buffer[] = []
        let offset = 0
        while (offset < input.sizeBytes) {
          signal?.throwIfAborted()
          request.signal?.throwIfAborted()
          const chunk = Buffer.alloc(Math.min(64 * 1024, input.sizeBytes - offset))
          const { bytesRead } = await lease.read(chunk, 0, chunk.length, offset)
          if (!Number.isSafeInteger(bytesRead) || bytesRead < 1 || bytesRead > chunk.length)
            reject('material ended early or returned an invalid read size.')
          offset += bytesRead
          if (offset > maxBytes) reject('material exceeds the read byte limit.')
          chunks.push(chunk.subarray(0, bytesRead))
        }
        const extra = await lease.read(Buffer.alloc(1), 0, 1, offset)
        if (extra.bytesRead !== 0) reject('material grew beyond its frozen Version.')
        await lease.verifyUnchanged()
        await assertCurrent(signal)
        const content = Buffer.concat(chunks, offset)
        if (digest(content) !== input.checksum) reject('material content checksum changed.')
        return content
      } finally {
        await lease.close()
      }
    }
  }
}

const assertCatalogIdentity = (row: HostArtifactCatalogItem, input: NotebookRunInputFile): void => {
  if (
    input.inputFileVersionId !== row.versionId ||
    input.sourceProjectId !== row.projectId ||
    input.sourceSessionId !== row.sessionId ||
    input.sourceFileId !== row.sourceFileId ||
    input.filename !== row.filename ||
    input.sourceKind !== (row.source === 'artifact' ? 'artifact-version' : 'upload-version') ||
    input.sizeBytes !== row.sizeBytes ||
    (row.checksum !== undefined && input.checksum !== row.checksum) ||
    !/^[a-f0-9]{64}$/u.test(input.checksum) ||
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes < 0
  )
    reject('catalog and immutable Version identity disagree.')
}

/** Revalidate one input from a Main-owned prepared receipt before Notebook registration.
 * This checks immutable identity, not source-selection authority; never expose it as discovery.
 * Registration records an attachment only, without claiming that execution observed its bytes.
 */
export const resolvePreparedResearchMaterialInput = async (
  dependencies: {
    catalog: HostArtifactCatalog
    inputAuthority: Pick<ImmutableInputAuthority, 'resolveVersion'>
  },
  request: { projectId: string } & Pick<
    ResearchMaterialVersion,
    'versionId' | 'sha256' | 'sizeBytes'
  >
): Promise<NotebookRunInputFile> => {
  sessionPackageRequestSchema.shape.projectId.parse(request.projectId)
  if (
    !request.versionId ||
    request.versionId.length > 512 ||
    !/^[a-f0-9]{64}$/u.test(request.sha256) ||
    !Number.isSafeInteger(request.sizeBytes) ||
    request.sizeBytes < 0
  )
    return reject('invalid prepared Version identity.')
  const rows = await dependencies.catalog.readHostArtifactCatalog({
    projectId: request.projectId,
    versionId: request.versionId
  })
  if (
    rows.length !== 1 ||
    rows[0].projectId !== request.projectId ||
    rows[0].versionId !== request.versionId
  )
    return reject('prepared Version is unavailable or ambiguous.')
  const row = rows[0]
  const input = await dependencies.inputAuthority.resolveVersion({
    projectId: request.projectId,
    sourceKind: row.source === 'artifact' ? 'artifact-version' : 'upload-version',
    inputFileVersionId: request.versionId,
    expectedSourceFileId: row.sourceFileId
  })
  if (!input) return reject('prepared Version is unavailable.')
  assertCatalogIdentity(row, input)
  if (input.checksum !== request.sha256 || input.sizeBytes !== request.sizeBytes)
    return reject('prepared Version content identity changed.')
  const registered = structuredClone(input)
  registered.association = 'turn-attached'
  delete registered.accessEvidence
  return registered
}
