import type { BigIntStats } from 'node:fs'
import { lstat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { readFileWithinLimit } from '@aipoch/durable-files'
import { z } from 'zod'
import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  PACKAGE_MAX_BYTES,
  PACKAGE_MAX_FILE_BYTES,
  type SessionPackageManifest,
  type PackageProgress
} from '../../shared/session-package'
import {
  readStoredResearchFilm,
  deletedResearchFilmIds
} from '../research-video/stored-presentation'
import { copyFileWithinBudget, digestFileWithinBudget } from '../bounded-file-io'
import { assertPackageSourcePath, packageEntry } from './archive'
import { assertPackageCapacity } from './capacity'
import {
  packageResearchFilmsSchema,
  researchFilmStorageKeys,
  type PackageResearchFilms
} from './research-films-contract'
import type { PackageRecords } from './records-contract'

export type CapturedResearchFilms = {
  films: PackageResearchFilms
  files: Map<string, { sourceKey: string; sizeBytes: number; observation: string }>
}

const fileObservation = (stat: BigIntStats): string =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`

/** Portable aliases stay inside the existing imported Artifact scope and its deletion journal. */
export async function captureResearchFilms(
  root: string,
  session: PersistedChatSession,
  inherited: PackageResearchFilms = [],
  signal?: AbortSignal
): Promise<CapturedResearchFilms> {
  inherited = (
    await Promise.all(
      inherited.map(async (film) =>
        (
          await deletedResearchFilmIds(root, {
            projectId: session.projectId,
            sessionId: session.id,
            branchId: film.branchId
          })
        ).includes(film.id)
          ? undefined
          : film
      )
    )
  ).filter((film): film is PackageResearchFilms[number] => Boolean(film))
  const films = new Map(inherited.map((film) => [film.branchId ?? '', film]))
  const sources = new Map(researchFilmStorageKeys(inherited).map((key) => [key, key]))
  const localUpdated = new Map<string, number>()
  const branches = new Set(session.conversationGraph?.branches.map((branch) => branch.id) ?? [])
  for (const branchId of [undefined, ...branches]) {
    signal?.throwIfAborted()
    const film = await readStoredResearchFilm(root, {
      projectId: session.projectId,
      sessionId: session.id,
      branchId
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!film) continue
    const sourcePath = join(dirname(dirname(film.playerPath)), 'session.json')
    await assertPackageSourcePath(root, relative(root, sourcePath).split(sep).join('/'))
    const source = z
      .object({
        provenance: z.object({
          projectId: z.string(),
          sessionId: z.string(),
          branchId: z.string().optional()
        })
      })
      .parse(JSON.parse(await readFileWithinLimit(sourcePath, 8 * 1024 * 1024)))
    const owner = source.provenance
    if (
      owner.projectId !== session.projectId ||
      owner.sessionId !== session.id ||
      (owner.branchId && !branches.has(owner.branchId))
    )
      continue
    const updatedAt = (await lstat(join(dirname(dirname(dirname(film.playerPath))), 'latest.json')))
      .mtimeMs
    if (updatedAt < (localUpdated.get(owner.branchId ?? '') ?? -Infinity)) continue
    localUpdated.set(owner.branchId ?? '', updatedAt)
    const prefix = `artifacts/${session.projectId}/${session.id}/.research-films/${film.id}`
    const playerStorageKey = `${prefix}/player.html`,
      sourceStorageKey = `${prefix}/sources.zip`
    films.set(owner.branchId ?? '', {
      id: film.id,
      title: film.title,
      duration: film.duration,
      ...(owner.branchId ? { branchId: owner.branchId } : {}),
      playerStorageKey,
      sourceStorageKey
    })
    sources.set(playerStorageKey, relative(root, film.playerPath).split(sep).join('/'))
    sources.set(sourceStorageKey, relative(root, film.sourcePath).split(sep).join('/'))
  }
  const selected = [...films.values()]
  const files: CapturedResearchFilms['files'] = new Map()
  for (const key of researchFilmStorageKeys(selected)) {
    const sourceKey = sources.get(key)!
    await assertPackageSourcePath(root, sourceKey)
    const stat = await lstat(join(root, sourceKey), { bigint: true })
    if (!stat.isFile()) throw new Error('Research presentation is unavailable.')
    const sizeBytes = Number(stat.size)
    if (sizeBytes > PACKAGE_MAX_FILE_BYTES)
      throw new Error('Research film exceeds the package file size limit.')
    files.set(key, { sourceKey, sizeBytes, observation: fileObservation(stat) })
  }
  if (selected.length) packageResearchFilmsSchema.parse(selected)
  return { films: selected, files }
}

export function validateResearchFilms(
  records: PackageRecords,
  manifest: SessionPackageManifest,
  session?: PersistedChatSession
): void {
  const films = records.researchFilms
  if (Boolean(films?.length) !== Boolean(manifest.requiredFeatures?.includes('research-film')))
    throw new Error('Research film package capability declaration is invalid.')
  const keys = new Set(researchFilmStorageKeys(films)),
    branches = new Set<string>(),
    ids = new Set<string>()
  for (const film of films ?? []) {
    const prefix = `artifacts/${manifest.source.projectId}/${manifest.source.sessionId}/.research-films/${film.id}`
    if (
      film.playerStorageKey !== `${prefix}/player.html` ||
      film.sourceStorageKey !== `${prefix}/sources.zip` ||
      branches.has(film.branchId ?? '') ||
      ids.has(film.id)
    )
      throw new Error('Invalid research film ownership or duplicate branch.')
    if (
      session &&
      film.branchId &&
      !session.conversationGraph?.branches.some((branch) => branch.id === film.branchId)
    )
      throw new Error('Research film branch is unavailable.')
    branches.add(film.branchId ?? '')
    ids.add(film.id)
    for (const key of [film.playerStorageKey, film.sourceStorageKey]) {
      const entry = manifest.inventory.find((entry) => entry.storageKey === key)
      if (!entry || entry.kind !== 'file') throw new Error('Research film content is missing.')
    }
  }
  for (const entry of manifest.inventory) {
    if (entry.storageKey?.split('/')[3] === '.research-films' && !keys.has(entry.storageKey))
      throw new Error('Unlisted research film content.')
  }
}

export async function appendResearchFilms(options: {
  root: string
  directory: string
  captured: CapturedResearchFilms
  records: PackageRecords
  manifest: SessionPackageManifest
  signal: AbortSignal
  checkFile: (path: string, storageKey: string, checksum: string) => Promise<void>
  onProgress?: (progress: PackageProgress) => void
}): Promise<void> {
  const { root, directory, captured, records, manifest, signal } = options
  if (!captured.films.length) return
  const totalBytes = [...captured.files.values()].reduce((sum, file) => sum + file.sizeBytes, 0)
  if (
    manifest.inventory.reduce((sum, entry) => sum + entry.sizeBytes, 0) + totalBytes >
    PACKAGE_MAX_BYTES
  )
    throw new Error('Session package exceeds the size limit.')
  await assertPackageCapacity(directory, totalBytes)
  let completedBytes = 0
  for (const [storageKey, file] of captured.files) {
    signal.throwIfAborted()
    await assertPackageSourcePath(root, file.sourceKey)
    if (
      fileObservation(await lstat(join(root, file.sourceKey), { bigint: true })) !==
      file.observation
    )
      throw new Error('Research film changed during export. Try again.')
    const digest = await digestFileWithinBudget(join(root, file.sourceKey), file.sizeBytes, signal)
    if (digest.sizeBytes !== file.sizeBytes)
      throw new Error('Research film changed during export. Try again.')
    const objectPath = `objects/${digest.checksum}`
    if (manifest.inventory.some((entry) => entry.path === objectPath)) {
      manifest.requiredFeatures = [
        ...new Set([...(manifest.requiredFeatures ?? []), 'content-dedupe' as const])
      ]
    } else {
      const copied = await copyFileWithinBudget(
        join(root, file.sourceKey),
        join(directory, objectPath),
        file.sizeBytes,
        signal,
        (bytes) =>
          options.onProgress?.({
            phase: 'copying',
            completedBytes: completedBytes + bytes,
            totalBytes,
            currentFile: storageKey
          })
      )
      if (copied.checksum !== digest.checksum || copied.sizeBytes !== file.sizeBytes)
        throw new Error('Research film changed during export. Try again.')
    }
    if (
      fileObservation(await lstat(join(root, file.sourceKey), { bigint: true })) !==
      file.observation
    )
      throw new Error('Research film changed during export. Try again.')
    completedBytes += file.sizeBytes
    await options.checkFile(join(directory, objectPath), storageKey, digest.checksum)
    manifest.inventory.push({
      path: objectPath,
      kind: 'file',
      storageKey,
      checksum: digest.checksum,
      sizeBytes: file.sizeBytes
    })
  }
  records.researchFilms = captured.films
  manifest.requiredFeatures = [
    ...new Set([...(manifest.requiredFeatures ?? []), 'research-film' as const])
  ]
  await writeFile(join(directory, 'records.json'), JSON.stringify(records))
  const recordEntry = await packageEntry(directory, 'records.json', 'records')
  manifest.inventory = manifest.inventory.map((entry) =>
    entry.path === 'records.json' ? recordEntry : entry
  )
}
