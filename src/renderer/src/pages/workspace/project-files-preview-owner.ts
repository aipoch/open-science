import { useEffect, useMemo, useRef, useState } from 'react'

import type { ArtifactPreviewResult } from '../../../../shared/artifacts'
import type { ProjectFileItem } from '../../../../shared/project-files'

import {
  ARTIFACT_IMAGE_PREVIEW_BYTES,
  ARTIFACT_PREVIEW_BYTES,
  getArtifactPreviewFormat
} from './artifact-preview-utils'
import { createKeyedRequestReader } from './project-file-preview-queue'
import type { MessageArtifact } from './preview-file-item'
import { getPreviewThumbnailReadEncoding } from './preview-support'
import { isUnavailableFileError } from './previews/preview-errors'
import { createPreviewRequestScope, getPreviewFileReader } from './previews/preview-file-reader'

type ProjectFilePreviewTarget = {
  id: string
  path: string
  source: 'artifact' | 'upload'
  artifact: MessageArtifact
  projectId: string
  sessionId: string
  fileId: string
  cacheKey: string
  encoding?: 'utf8' | 'base64'
}

type ReadableProjectFilePreviewTarget = ProjectFilePreviewTarget & {
  encoding: 'utf8' | 'base64'
}

type ProjectFilePreviewEntry = {
  cacheKey: string
  preview: ArtifactPreviewResult | undefined
}

// Each stable file id retains only its current path/version preview entry.
type ProjectFilePreviewState = Record<string, ProjectFilePreviewEntry | undefined>
type ProjectFilePreviewReadResult = ProjectFilePreviewEntry & { id: string }

type ProjectFilePreviewReader = ((
  target: ReadableProjectFilePreviewTarget
) => Promise<ProjectFilePreviewReadResult>) & {
  setActiveKeys?: (keys: ReadonlySet<string>) => void
}

const PREVIEW_READ_CONCURRENCY = 4
const MAX_PREVIEW_CACHE_ENTRIES = 96

const createProjectFilePreviewArtifact = (file: ProjectFileItem): MessageArtifact => ({
  id: file.sourceVersionId,
  artifactId: file.source === 'artifact' ? file.sourceFileId : undefined,
  versionId: file.sourceVersionId,
  kind: 'managed-file',
  path: file.path,
  name: file.name,
  mimeType: file.mimeType,
  size: file.size,
  mtimeMs: file.mtimeMs
})

// A moved or rewritten file is a new cache entry even when its stable UI id stays the same.
const getProjectFilePreviewCacheKey = ({
  id,
  path,
  source,
  artifact
}: Pick<ProjectFilePreviewTarget, 'id' | 'path' | 'source' | 'artifact'>): string =>
  JSON.stringify([source, id, path, artifact.size ?? null, artifact.mtimeMs ?? null])

// Builds the source-neutral capability and source-specific read metadata used by File tiles.
const createProjectFilePreviewTarget = (file: ProjectFileItem): ProjectFilePreviewTarget => {
  const artifact = createProjectFilePreviewArtifact(file)
  const target = {
    id: file.id,
    path: file.path,
    source: file.source,
    artifact,
    projectId: file.projectId,
    sessionId: file.sessionId,
    fileId: file.sourceFileId
  }

  return {
    ...target,
    cacheKey: getProjectFilePreviewCacheKey(target),
    encoding: getPreviewThumbnailReadEncoding(getArtifactPreviewFormat(artifact))
  }
}

// Skips unsupported, cached, and oversized image targets before any IPC reads start.
const getMissingProjectFilePreviewTargets = (
  targets: ProjectFilePreviewTarget[],
  previews: ProjectFilePreviewState
): ReadableProjectFilePreviewTarget[] =>
  targets
    .filter((target): target is ReadableProjectFilePreviewTarget => target.encoding !== undefined)
    .filter((target) => previews[target.id]?.cacheKey !== target.cacheKey)
    .filter(
      (target) =>
        target.encoding !== 'base64' ||
        (typeof target.artifact.size === 'number' &&
          target.artifact.size <= ARTIFACT_IMAGE_PREVIEW_BYTES)
    )

// Reads one tile through its source-specific IPC while retaining the source-neutral cache identity.
const readProjectFilePreview = async (
  target: ReadableProjectFilePreviewTarget
): Promise<ProjectFilePreviewReadResult> => {
  const readPreview = getPreviewFileReader(target.source)

  try {
    const preview = await readPreview({
      path: target.path,
      ...createPreviewRequestScope({
        projectId: target.projectId,
        sessionId: target.sessionId,
        source: target.source,
        path: target.path
      }),
      fileId: target.fileId,
      maxBytes:
        target.encoding === 'base64' ? ARTIFACT_IMAGE_PREVIEW_BYTES : ARTIFACT_PREVIEW_BYTES,
      encoding: target.encoding
    })

    return { id: target.id, cacheKey: target.cacheKey, preview }
  } catch (error) {
    // Missing or out-of-root files are represented on the tile; only unexpected read failures belong
    // in the console because unavailable files are a normal state after deletion or data-root changes.
    if (!isUnavailableFileError(error)) {
      console.error('Failed to read project file preview', error)
    }
    return { id: target.id, cacheKey: target.cacheKey, preview: undefined }
  }
}

// Current tiles stay protected; retain at most one compact page pool of hidden previews for return
// navigation without letting collapsed or previously paged sections grow the cache indefinitely.
const trimProjectFilePreviews = (
  currentPreviews: ProjectFilePreviewState,
  protectedIds: ReadonlySet<string>
): ProjectFilePreviewState => {
  const keys = Object.keys(currentPreviews)
  const hiddenIds = keys.filter((id) => !protectedIds.has(id))
  if (hiddenIds.length <= MAX_PREVIEW_CACHE_ENTRIES) return currentPreviews

  const nextPreviews = { ...currentPreviews }
  const removeCount = hiddenIds.length - MAX_PREVIEW_CACHE_ENTRIES
  for (const id of hiddenIds.slice(0, removeCount)) {
    delete nextPreviews[id]
  }
  return nextPreviews
}

// Merges one completed read batch without dropping cached entries for other visible files.
const mergeProjectFilePreviews = (
  currentPreviews: ProjectFilePreviewState,
  previews: ProjectFilePreviewReadResult[],
  protectedIds: ReadonlySet<string>
): ProjectFilePreviewState => {
  const nextPreviews = previews.reduce<ProjectFilePreviewState>(
    (nextPreviews, item) => {
      // Reinsert completed entries so object insertion order acts as a compact LRU approximation.
      delete nextPreviews[item.id]
      nextPreviews[item.id] = { cacheKey: item.cacheKey, preview: item.preview }
      return nextPreviews
    },
    { ...currentPreviews }
  )

  return trimProjectFilePreviews(nextPreviews, protectedIds)
}

const getProjectFilePreviewRequestKey = (target: ProjectFilePreviewTarget): string =>
  `${target.projectId}:${target.cacheKey}`

// Shares one queue across render batches so preview reads remain capped and deduplicated even when
// pagination, filters, or section expansion update the target list in quick succession.
const createProjectFilePreviewReader = (
  read: ProjectFilePreviewReader = readProjectFilePreview,
  maxConcurrency = PREVIEW_READ_CONCURRENCY
): ProjectFilePreviewReader =>
  createKeyedRequestReader(read, getProjectFilePreviewRequestKey, maxConcurrency, {
    getGenerationKey: (target) => target.projectId,
    createCanceledResult: (target) => ({
      id: target.id,
      cacheKey: target.cacheKey,
      preview: undefined
    })
  })

// Keeps one queue alive across keyed ProjectFilesViewContent mounts so project changes cancel stale
// queued work without creating a second concurrency pool.
const useProjectFilePreviewReader = (): ProjectFilePreviewReader => {
  const [reader] = useState<ProjectFilePreviewReader>(() => createProjectFilePreviewReader())
  return reader
}

/**
 * Maintains version-aware tile previews for the currently rendered file targets.
 *
 * Active request keys cancel queued reads for collapsed/filtered files. Attempted keys suppress retry
 * loops for failed reads, but are removed once a target leaves the active set so an evicted preview is
 * eligible for a fresh read when the user returns. Completed batches merge without evicting visible
 * tiles, while hidden entries are bounded separately.
 */
const useProjectFilePreviews = (
  files: ProjectFileItem[],
  previewReader: ProjectFilePreviewReader
): Map<string, ArtifactPreviewResult | undefined> => {
  const previewTargets = useMemo(() => files.map(createProjectFilePreviewTarget), [files])
  const [filePreviews, setFilePreviews] = useState<ProjectFilePreviewState>({})
  const attemptedCacheKeyByIdRef = useRef(new Map<string, string>())

  useEffect(() => {
    const activeCacheKeys = new Map(
      previewTargets.map((target) => [target.id, target.cacheKey] as const)
    )
    const protectedIds = new Set(activeCacheKeys.keys())
    const attemptedCacheKeys = attemptedCacheKeyByIdRef.current
    let canceled = false
    previewReader.setActiveKeys?.(new Set(previewTargets.map(getProjectFilePreviewRequestKey)))

    // Attempts only suppress cache-eviction loops for the current render set. Hidden evicted files
    // must be eligible for a fresh read when the user returns to them.
    for (const [id, cacheKey] of attemptedCacheKeys) {
      if (activeCacheKeys.get(id) !== cacheKey) attemptedCacheKeys.delete(id)
    }
    void Promise.resolve().then(() => {
      if (!canceled) {
        setFilePreviews((current) => trimProjectFilePreviews(current, protectedIds))
      }
    })

    const missingTargets = getMissingProjectFilePreviewTargets(previewTargets, filePreviews).filter(
      (target) => attemptedCacheKeys.get(target.id) !== target.cacheKey
    )
    if (missingTargets.length === 0) {
      return () => {
        canceled = true
        previewReader.setActiveKeys?.(new Set())
      }
    }

    let completed = false
    for (const target of missingTargets) {
      attemptedCacheKeys.set(target.id, target.cacheKey)
    }

    void Promise.all(missingTargets.map(previewReader)).then((previews) => {
      completed = true
      if (canceled) return
      setFilePreviews((current) => mergeProjectFilePreviews(current, previews, protectedIds))
    })

    return () => {
      canceled = true
      previewReader.setActiveKeys?.(new Set())
      if (!completed) {
        for (const target of missingTargets) {
          if (attemptedCacheKeys.get(target.id) === target.cacheKey) {
            attemptedCacheKeys.delete(target.id)
          }
        }
      }
    }
  }, [filePreviews, previewReader, previewTargets])

  // A previous version may remain cached while the current path loads; never render it as current.
  return useMemo(
    () =>
      new Map(
        previewTargets.map((target) => {
          const entry = filePreviews[target.id]
          return [
            target.id,
            entry?.cacheKey === target.cacheKey ? entry.preview : undefined
          ] as const
        })
      ),
    [filePreviews, previewTargets]
  )
}

export { createProjectFilePreviewArtifact, useProjectFilePreviewReader, useProjectFilePreviews }
export type { ProjectFilePreviewReader }
