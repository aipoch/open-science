import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import {
  compareResearchReproductionArchiveEntries,
  parseResearchReproductionDescription,
  RESEARCH_REPRODUCTION_MAX_BYTES,
  resolveResearchReproductionMaterials,
  type ResearchReproductionArchiveEntry,
  type ResearchReproductionDescription,
  type ResearchReproductionInspection
} from '../../shared/research-reproduction'
import {
  inspectResearchMaterialArchive,
  researchMaterialEntryMetadata,
  validateResearchMaterialPaths,
  type PreparedResearchEntry
} from './research-material-archive'

export type ResearchMaterialSource = {
  projectId: string
  sessionId: string
  // The caller's verified import/closure identity; never an author-supplied local ID.
  identity: string
  title?: string
}
export type ResearchMaterialVersion = {
  versionId: string
  sourceIdentity: string
  filename: string
  sha256: string
  sizeBytes: number
  contentAvailable?: boolean
  descriptor?: boolean
}
export type ResearchMaterialAuthority = {
  source: ResearchMaterialSource
  // MUST be the authoritative selected research closure, not a relabelled Project-wide catalog.
  // Main owns admission and the reader; callers cannot mint this capability from package JSON.
  versions: readonly ResearchMaterialVersion[]
  // The reader must enforce maxBytes during I/O; this module verifies size/hash again afterwards.
  readVersion(
    versionId: string,
    options: { maxBytes: number; signal?: AbortSignal }
  ): Promise<Uint8Array>
}
export type ResearchMaterialLimits = {
  maxInputBytes: number
  maxExpandedBytes: number
  maxEntries: number
}
export const DEFAULT_RESEARCH_MATERIAL_LIMITS: Readonly<ResearchMaterialLimits> = Object.freeze({
  maxInputBytes: 128 * 1024 ** 2,
  maxExpandedBytes: 256 * 1024 ** 2,
  maxEntries: 10_000
})
type MaterialStatus = {
  key: string
  status: 'available' | 'external' | 'withheld' | 'missing' | 'mismatch'
  versionIds?: string[]
}
export type ResearchMaterialUnavailableReason = Exclude<MaterialStatus['status'], 'available'>

// Public explanations are selected only from this fixed vocabulary, never from file paths,
// author-provided descriptions, material keys, or the message of an arbitrary underlying error.
export const researchMaterialUnavailableMessage = (reason: unknown): string | undefined => {
  switch (reason) {
    case 'missing':
      return 'The selected research material is unavailable. Inspect the research materials and select an available version.'
    case 'withheld':
      return 'The selected research material was withheld from the package. Select materials that were shared.'
    case 'external':
      return 'The selected research material is external to the package and is not available for preparation.'
    case 'mismatch':
      return 'The available research material does not match the declared version. Inspect the research materials and select a matching version.'
    default:
      return undefined
  }
}

export class ResearchMaterialUnavailableError extends Error {
  constructor(readonly reason: ResearchMaterialUnavailableReason) {
    super(researchMaterialUnavailableMessage(reason))
    this.name = 'ResearchMaterialUnavailableError'
  }
}

export const RESEARCH_MATERIAL_VERSION_SELECTION_MESSAGE =
  'Select a matching immutable version explicitly in materials.materialVersions using the IDs returned by inspectMaterials.'

export class ResearchMaterialVersionSelectionError extends Error {
  constructor() {
    super(RESEARCH_MATERIAL_VERSION_SELECTION_MESSAGE)
    this.name = 'ResearchMaterialVersionSelectionError'
  }
}
export type ResearchMaterialInspection = {
  source: ResearchMaterialSource
  status: 'no-description' | 'choose-description' | 'ready' | 'unsupported' | 'invalid'
  descriptorCandidates: ResearchMaterialVersion[]
  descriptor?: ResearchMaterialVersion
  inspection?: ResearchReproductionInspection
  description?: ResearchReproductionDescription
  materials?: MaterialStatus[]
}
export type PreparedResearchMaterials = {
  source: ResearchMaterialSource
  inputs: Array<ResearchMaterialVersion & { materialKey?: string; restorePath?: string }>
  entries: ResearchReproductionArchiveEntry[]
  totalBytes: number
}

const digest = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')
const failure = (message: string): never => {
  throw new Error(`Research materials: ${message}`)
}
const freezeAuthority = (authority: ResearchMaterialAuthority): ResearchMaterialAuthority => {
  const source = structuredClone(authority.source)
  const versions = structuredClone(authority.versions)
  if (!source.identity || !source.projectId || !source.sessionId)
    failure('a verified source identity is required.')
  const ids = new Set<string>()
  for (const version of versions) {
    if (
      version.sourceIdentity !== source.identity ||
      !version.versionId ||
      ids.has(version.versionId) ||
      !/^[a-f0-9]{64}$/u.test(version.sha256) ||
      !Number.isSafeInteger(version.sizeBytes) ||
      version.sizeBytes < 0
    )
      failure('the version catalog is invalid or contains another research source.')
    ids.add(version.versionId)
  }
  return { source, versions, readVersion: authority.readVersion.bind(authority) }
}

const readVerified = async (
  authority: ResearchMaterialAuthority,
  version: ResearchMaterialVersion,
  maxBytes: number,
  signal?: AbortSignal
): Promise<Buffer> => {
  signal?.throwIfAborted()
  if (version.contentAvailable === false) throw new ResearchMaterialUnavailableError('missing')
  if (version.sizeBytes > maxBytes) failure('input byte limit exceeded.')
  const received = await authority.readVersion(version.versionId, { maxBytes, signal })
  signal?.throwIfAborted()
  if (received.byteLength > maxBytes) failure('the reader exceeded the input byte limit.')
  const bytes = Buffer.from(received)
  if (bytes.length !== version.sizeBytes || digest(bytes) !== version.sha256)
    failure('the selected version content changed or failed verification.')
  return bytes
}

export const inspectResearchMaterials = async (
  input: ResearchMaterialAuthority,
  options: { descriptorVersionId?: string; signal?: AbortSignal } = {}
): Promise<ResearchMaterialInspection> => {
  const authority = freezeAuthority(input)
  options.signal?.throwIfAborted()
  const candidates = authority.versions.filter(
    (version) => version.descriptor || version.filename === 'research-reproduction.json'
  )
  const base = { source: authority.source, descriptorCandidates: candidates }
  if (!options.descriptorVersionId && !candidates.length)
    return { ...base, status: 'no-description' }
  if (!options.descriptorVersionId && candidates.length > 1)
    return { ...base, status: 'choose-description' }
  const descriptor = options.descriptorVersionId
    ? authority.versions.find((version) => version.versionId === options.descriptorVersionId)
    : candidates[0]
  if (!descriptor) return failure('the descriptor is outside the selected research.')
  const bytes = await readVerified(
    authority,
    descriptor,
    RESEARCH_REPRODUCTION_MAX_BYTES,
    options.signal
  )
  const inspection = parseResearchReproductionDescription(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  )
  if (inspection.status !== 'valid')
    return { ...base, descriptor, inspection, status: inspection.status }
  const materials = resolveResearchReproductionMaterials(inspection.description, {
    researchId: authority.source.identity,
    artifacts: authority.versions.map((version) => ({
      researchId: version.sourceIdentity,
      artifactId: version.versionId,
      filename: version.filename,
      sha256: version.sha256,
      sizeBytes: version.sizeBytes,
      contentAvailable: version.contentAvailable
    }))
  }).map(({ artifactIds, ...material }) => ({
    ...material,
    ...(artifactIds ? { versionIds: artifactIds } : {})
  }))
  return {
    ...base,
    descriptor,
    inspection,
    status: 'ready',
    description: inspection.description,
    materials
  }
}

const configuredLimits = (requested?: Partial<ResearchMaterialLimits>): ResearchMaterialLimits => {
  const limits = { ...DEFAULT_RESEARCH_MATERIAL_LIMITS, ...requested }
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value < 1) failure('invalid host limits.')
  // Host settings may raise ordinary defaults, but these buffered readers have a hard memory bound.
  if (
    limits.maxInputBytes > 1024 ** 3 ||
    limits.maxExpandedBytes > 2 * 1024 ** 3 ||
    limits.maxEntries > 10_000
  )
    failure('host limits exceed the supported bounded reader.')
  return limits
}

export type PrepareResearchMaterialOptions = {
  stagingDirectory: string
  // Without a descriptor, each selected immutable Version is copied verbatim, never auto-extracted.
  files?: Array<{ versionId: string; restorePath: string }>
  descriptorVersionId?: string
  materialKeys?: string[]
  // Required only when several Versions match one material's immutable content identity.
  materialVersions?: Record<string, string>
  limits?: Partial<ResearchMaterialLimits>
  signal?: AbortSignal
}

// The caller exclusively owns an empty staging directory and its parent through completion.
// Nothing becomes ready/published here. On any failure the owner retains/cleans partial staging;
// it may atomically publish only after this function returns its verified receipt.
export const prepareResearchMaterials = async (
  input: ResearchMaterialAuthority,
  requested: PrepareResearchMaterialOptions
): Promise<PreparedResearchMaterials> => {
  const authority = freezeAuthority(input)
  const { signal } = requested
  const options = structuredClone({ ...requested, signal: undefined })
  const limits = configuredLimits(options.limits)
  signal?.throwIfAborted()
  if (!isAbsolute(options.stagingDirectory)) failure('staging must be an absolute directory.')
  const initial = await lstat(options.stagingDirectory)
  if (
    !initial.isDirectory() ||
    initial.isSymbolicLink() ||
    (process.getuid && initial.uid !== process.getuid()) ||
    (process.platform !== 'win32' && (initial.mode & 0o077) !== 0) ||
    (await readdir(options.stagingDirectory)).length
  )
    failure('staging must be an empty, private, owner-controlled directory.')
  const root = await realpath(options.stagingDirectory)
  const checkRoot = async (): Promise<void> => {
    signal?.throwIfAborted()
    const current = await lstat(options.stagingDirectory)
    if (!current.isDirectory() || current.dev !== initial.dev || current.ino !== initial.ino)
      failure('staging directory identity changed.')
  }
  const entries: PreparedResearchEntry[] = []
  const inputs: PreparedResearchMaterials['inputs'] = []
  let inputBytes = 0
  let totalBytes = 0
  const addEntries = (incoming: PreparedResearchEntry[]): void => {
    const bytes = incoming.reduce((sum, row) => sum + (row.type === 'file' ? row.sizeBytes : 0), 0)
    if (
      totalBytes + bytes > limits.maxExpandedBytes ||
      entries.length + incoming.length > limits.maxEntries
    )
      failure('the selected materials exceed the host output limits.')
    totalBytes += bytes
    entries.push(...incoming)
  }
  const read = async (version: ResearchMaterialVersion): Promise<Buffer> => {
    const content = await readVerified(
      authority,
      version,
      limits.maxInputBytes - inputBytes,
      signal
    )
    inputBytes += content.length
    return content
  }
  const findVersion = (id: string): ResearchMaterialVersion =>
    authority.versions.find((version) => version.versionId === id) ??
    failure('the requested version is outside the selected research.')

  if (options.descriptorVersionId) {
    if (options.files?.length)
      failure('descriptor materials cannot override declared restore paths.')
    if (findVersion(options.descriptorVersionId).sizeBytes > limits.maxInputBytes)
      failure('input byte limit exceeded.')
    const inspection = await inspectResearchMaterials(authority, {
      descriptorVersionId: options.descriptorVersionId,
      signal
    })
    if (inspection.status !== 'ready' || !inspection.description || !inspection.descriptor)
      return failure('the selected descriptor is invalid or unsupported.')
    inputBytes += inspection.descriptor.sizeBytes
    if (inputBytes > limits.maxInputBytes) failure('input byte limit exceeded.')
    inputs.push(inspection.descriptor)
    if (
      !options.materialKeys?.length ||
      new Set(options.materialKeys).size !== options.materialKeys.length
    )
      return failure('select unique material keys explicitly.')
    if (
      Object.keys(options.materialVersions ?? {}).some(
        (key) => !options.materialKeys?.includes(key)
      )
    )
      failure('a version override does not name a selected material.')
    for (const key of options.materialKeys) {
      const material = inspection.description.materials.find((row) => row.key === key)
      const state = inspection.materials?.find((row) => row.key === key)
      if (!material || !state)
        return failure('a selected material is outside the selected description.')
      if (state.status !== 'available') throw new ResearchMaterialUnavailableError(state.status)
      if (material.availability !== 'included')
        return failure('a selected material is missing, withheld, external or mismatched.')
      const selected = options.materialVersions?.[key]
      const versionId =
        selected ?? (state.versionIds?.length === 1 ? state.versionIds[0] : undefined)
      if (!versionId || !state.versionIds?.includes(versionId))
        throw new ResearchMaterialVersionSelectionError()
      const version = findVersion(versionId)
      if (!material.archive && version.sizeBytes > limits.maxExpandedBytes - totalBytes)
        failure('the selected materials exceed the host output limits.')
      const bytes = await read(version)
      inputs.push({ ...version, materialKey: key, restorePath: material.restorePath })
      if (material.archive) {
        const restored = await inspectResearchMaterialArchive(
          bytes,
          material.archive.format,
          {
            maxExpandedBytes: limits.maxExpandedBytes - totalBytes,
            maxEntries: limits.maxEntries - entries.length - 1
          },
          signal
        )
        const compared = compareResearchReproductionArchiveEntries(
          material.archive.entries,
          restored.map(researchMaterialEntryMetadata)
        )
        if (compared.status !== 'matched')
          failure('archive bytes do not match the declared inventory.')
        addEntries([
          { path: material.restorePath, type: 'directory' },
          ...restored.map((row) => ({ ...row, path: `${material.restorePath}/${row.path}` }))
        ])
      } else {
        addEntries([
          {
            path: material.restorePath,
            type: 'file',
            sizeBytes: bytes.length,
            sha256: version.sha256,
            content: bytes
          }
        ])
      }
    }
  } else {
    if (options.materialKeys || options.materialVersions || !options.files?.length)
      return failure('select explicit versions and restore paths when there is no descriptor.')
    for (const file of options.files) {
      const version = findVersion(file.versionId)
      if (version.sizeBytes > limits.maxExpandedBytes - totalBytes)
        failure('the selected materials exceed the host output limits.')
      const bytes = await read(version)
      inputs.push({ ...version, restorePath: file.restorePath })
      addEntries([
        {
          path: file.restorePath,
          type: 'file',
          sizeBytes: bytes.length,
          sha256: version.sha256,
          content: bytes
        }
      ])
    }
  }
  validateResearchMaterialPaths(entries)
  await checkRoot()
  if ((await readdir(root)).length) failure('staging is no longer empty.')
  const directories = new Set<string>()
  for (const row of entries) {
    const parts = row.path.split('/')
    const count = row.type === 'directory' ? parts.length : parts.length - 1
    for (let length = 1; length <= count; length++)
      directories.add(parts.slice(0, length).join('/'))
  }
  for (const directory of [...directories].sort(
    (a, b) => a.split('/').length - b.split('/').length
  )) {
    await checkRoot()
    await mkdir(join(root, directory), { mode: 0o700 })
  }
  for (const row of entries) {
    if (row.type !== 'file') continue
    await checkRoot()
    const path = join(root, row.path)
    if ((await realpath(dirname(path))) !== dirname(path)) failure('staging parent changed.')
    const file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    )
    try {
      await file.writeFile(row.content!)
      await file.sync()
    } finally {
      await file.close()
    }
  }
  await checkRoot()
  return {
    source: authority.source,
    inputs,
    entries: entries.map(researchMaterialEntryMetadata),
    totalBytes
  }
}
