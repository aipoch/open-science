import type {
  PackageExcludedFile,
  PackageSelectableFile,
  SessionPackageInventoryEntry
} from '../../shared/session-package'
import type { NotebookRunDocument } from '../../shared/notebook'
import type { PackageRecords } from './native-snapshot'

// Only immutable file payloads are optional. Metadata, snapshots and their integrity checks remain
// required even when the user chooses not to share an Artifact's content.
export const selectablePackageFiles = (
  records: PackageRecords,
  notebooks: readonly NotebookRunDocument[] = []
): PackageSelectableFile[] => {
  const artifacts = records.tables.ArtifactVersion
  const versions = [...artifacts, ...records.tables.UploadVersion]
  const byId = new Map(artifacts.map((row) => [row.id, row]))
  const inputUsers = new Map<unknown, string[]>()
  const descendants = new Map<unknown, string[]>()
  const reviews = new Map<unknown, string[]>()
  const runs = new Map<unknown, string[]>()
  const add = (index: Map<unknown, string[]>, id: unknown, name: string): void => {
    const names = index.get(id)
    if (names) names.push(name)
    else index.set(id, [name])
  }
  for (const input of records.tables.ArtifactVersionInput) {
    const name = byId.get(input.artifactVersionId)?.filename
    if (typeof name === 'string') add(inputUsers, input.inputFileVersionId, name)
  }
  for (const version of versions)
    add(descendants, version.basedOnVersionId, String(version.filename))
  for (const review of records.tables.Review) {
    const scope = JSON.parse(String(review.scope))
    for (const id of new Set([
      ...(scope.artifactVersionIds ?? []),
      ...(scope.sourceDocumentVersionIds ?? [])
    ]))
      add(reviews, id, `Review ${review.id}`)
  }
  for (const document of notebooks) {
    for (const run of document.runs) {
      for (const id of new Set(run.inputFiles?.map((input) => input.inputFileVersionId)))
        add(runs, id, `Notebook ${run.runId}`)
    }
  }
  return [
    ...(records.reproducibility?.versions.flatMap((version) =>
      version.outputs
        .filter((file) => !version.omittedOutputChecksums.includes(file.checksum))
        .map((file) => ({
          ...file,
          groupId: version.versionId,
          source: 'reproducibility' as const,
          versionNumber: Number(byId.get(version.versionId)?.versionNumber ?? 1),
          dependentFiles: []
        }))
    ) ?? []),
    ...(['ArtifactVersion', 'UploadVersion'] as const).flatMap((table) =>
      records.tables[table].map((row) => ({
        storageKey: String(row.contentStorageKey),
        filename: String(row.filename),
        sizeBytes: Number(row.sizeBytes),
        groupId: String(row.artifactId ?? row.uploadFileId),
        source: table === 'ArtifactVersion' ? ('artifact' as const) : ('upload' as const),
        versionNumber: Number(row.versionNumber),
        dependentFiles: [
          ...new Set([
            ...(inputUsers.get(row.id) ?? []),
            ...(descendants.get(row.id) ?? []),
            ...(reviews.get(row.id) ?? []),
            ...(runs.get(row.id) ?? [])
          ])
        ]
      }))
    )
  ]
}

// Selection planning must not reread potentially large payloads. A known digest gives an exact
// match; otherwise equal size is conservatively treated as a possible retained copy. Disposable
// same-project Notebook inputs are omitted later with their original, after checksum validation.
export const markRequiredPackageFiles = (
  records: PackageRecords,
  files: PackageSelectableFile[],
  retained: readonly { storageKey?: string; sizeBytes: number; checksum?: string }[]
): PackageSelectableFile[] => {
  const checksums = new Map(
    [...records.tables.ArtifactVersion, ...records.tables.UploadVersion].map((row) => [
      String(row.contentStorageKey),
      String(row.checksum)
    ])
  )
  for (const version of records.reproducibility?.versions ?? [])
    for (const file of version.outputs) checksums.set(file.storageKey, file.checksum)
  const known = new Map<string, Set<string>>()
  const unknown = new Map<number, Set<string>>()
  for (const entry of retained) {
    const scope =
      entry.storageKey && isNotebookInputCopy(entry.storageKey)
        ? entry.storageKey.split('/')[1]
        : '*'
    if (entry.checksum) {
      const scopes = known.get(entry.checksum) ?? new Set<string>()
      scopes.add(scope)
      known.set(entry.checksum, scopes)
    } else {
      const scopes = unknown.get(entry.sizeBytes) ?? new Set<string>()
      scopes.add(scope)
      unknown.set(entry.sizeBytes, scopes)
    }
  }
  const requiredDigests = new Set<string>()
  const requiredKeys = new Set<string>()
  for (const file of files) {
    const digest = checksums.get(file.storageKey)
    const matches = (scopes: Set<string> | undefined): boolean =>
      Boolean(
        scopes?.size &&
        (file.source === 'reproducibility' ||
          scopes.has('*') ||
          scopes.size > 1 ||
          !scopes.has(file.storageKey.split('/')[1]))
      )
    if (matches(unknown.get(file.sizeBytes)) || (digest && matches(known.get(digest)))) {
      requiredKeys.add(file.storageKey)
      if (digest) requiredDigests.add(digest)
    }
  }
  // If a required payload shares bytes with another selectable version, both must stay included.
  return files.map((file) => ({
    ...file,
    requiredForEvidence:
      requiredKeys.has(file.storageKey) || requiredDigests.has(checksums.get(file.storageKey) ?? '')
  }))
}

export const validateExcludedFiles = (
  records: PackageRecords,
  excluded: readonly PackageExcludedFile[]
): Set<string> => {
  const allowed = new Map(
    [...records.tables.ArtifactVersion, ...records.tables.UploadVersion].map((row) => [
      String(row.contentStorageKey),
      { filename: String(row.filename), sizeBytes: Number(row.sizeBytes) }
    ])
  )
  for (const version of records.reproducibility?.versions ?? [])
    for (const file of version.outputs)
      allowed.set(file.storageKey, { filename: file.filename, sizeBytes: file.sizeBytes })
  const keys = new Set<string>()
  for (const file of excluded) {
    const source = allowed.get(file.storageKey)
    const inputCopy =
      !source &&
      isNotebookInputCopy(file.storageKey) &&
      excluded.some((original) => {
        const version = allowed.get(original.storageKey)
        return (
          version &&
          original.filename === file.filename &&
          original.sizeBytes === file.sizeBytes &&
          version.filename === original.filename &&
          version.sizeBytes === original.sizeBytes &&
          original.storageKey.split('/')[1] === file.storageKey.split('/')[1]
        )
      })
    if (
      keys.has(file.storageKey) ||
      (!inputCopy &&
        (!source || source.filename !== file.filename || source.sizeBytes !== file.sizeBytes))
    )
      throw new Error('Invalid package content exclusion.')
    keys.add(file.storageKey)
  }
  return keys
}

// Prompt-input materialization copies uploads here, outside the immutable execution evidence
// graph. These disposable copies can be omitted with their original payload; run/evidence JSON
// and generation blobs retain the stricter reader contract below.
export const isNotebookInputCopy = (key: string): boolean =>
  /^notebooks\/[^/]+\/[^/]+\/(?:frames\/[^/]+\/)?data\/inputs\/[^/]+$/.test(key)

export const excludedNotebookInputCopy = (
  records: PackageRecords,
  excluded: readonly PackageExcludedFile[],
  entry: { storageKey?: string; checksum: string; sizeBytes: number }
): PackageExcludedFile | undefined => {
  if (!entry.storageKey || !isNotebookInputCopy(entry.storageKey)) return
  const versions = [...records.tables.ArtifactVersion, ...records.tables.UploadVersion]
  const original = excluded.find(
    (file) =>
      file.sizeBytes === entry.sizeBytes &&
      versions.some(
        (version) =>
          version.contentStorageKey === file.storageKey &&
          version.checksum === entry.checksum &&
          file.storageKey.split('/')[1] === entry.storageKey!.split('/')[1]
      )
  )
  return original ? { ...original, storageKey: entry.storageKey } : undefined
}

// A payload may also be materialized in a Notebook workspace or generation blob. Until those
// owners expose omission-aware readers, reject conflicting selections instead of leaking bytes or
// weakening evidence integrity. Check the entire inventory, including retained metadata files.
export const assertNoExcludedContentCopies = (
  records: PackageRecords,
  excluded: readonly PackageExcludedFile[],
  inventory: readonly Pick<SessionPackageInventoryEntry, 'checksum'>[]
): void => {
  const keys = new Set(excluded.map((file) => file.storageKey))
  const checksums = new Set(
    [...records.tables.ArtifactVersion, ...records.tables.UploadVersion]
      .filter((row) => keys.has(String(row.contentStorageKey)))
      .map((row) => row.checksum)
  )
  if (inventory.some((entry) => checksums.has(entry.checksum)))
    throw new Error(
      'An excluded file also exists in retained research evidence. Include that file to export this Session.'
    )
}
