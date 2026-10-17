import { createHash, randomUUID } from 'node:crypto'
import {
  MAX_RUN_OBSERVATION_ARCHIVE_BYTES,
  parseRunObservationArchive,
  type RunObservationArchive
} from '../../shared/run-observation-archive'
import {
  recordedObservationTargetSchema,
  recordedFileRequestSchema,
  recordedFileSelectionForPayload,
  type RecordedFileRequest,
  type RecordedObservationFileSelection,
  type RecordedProjectPayload,
  type RecordedObservationPayload,
  type RecordedObservationTarget,
  type ResolvedObservationMedia
} from '../../shared/run-observation-recorded'
import {
  MAX_PROJECT_RECORDING_BYTES,
  parseProjectRecording,
  type ProjectRecording
} from '../../shared/project-recording'
import type { NotebookRunInputFile } from '../../shared/notebook'
import type { ImmutableInputAuthority } from '../immutable-input-authority'
import type { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import type { ManagedFileIndexRepository } from '../project-files/repository'
import { resolveRunObservationMedia, verifyRunObservationMediaBytes } from './archive'
import { readCollectionExecutionContext, unknownExecutionContext } from './execution-context'
import type { RunObservationExecutionContext } from '../../shared/run-observation'
import type { ArtifactVersionDescriptor } from '../../shared/artifact-provenance'
import {
  parseBrowserRecording,
  browserRecordingMomentSchema,
  type BrowserRecording,
  type RecordedBrowserPayload,
  type BrowserRecordingMoment
} from '../../shared/browser-recording'

export type RecordedObservationReaderDependencies = {
  immutableInputAuthority: Pick<ImmutableInputAuthority, 'resolveVersion' | 'openContent'>
  projectFilesRepository: Pick<ManagedFileIndexRepository, 'readExportFiles'>
  /** Main-only bounded historical lookup. Metadata is not read authorization. */
  artifactProvenanceRepository?: Pick<
    ArtifactProvenanceRepository,
    'resolvePublishedSessionVersionsByContent'
  > &
    Partial<Pick<ArtifactProvenanceRepository, 'resolveVersionDescriptors'>>
  authorizeScope(target: RecordedObservationTarget): Promise<void>
  /** Main-only retained import receipt or exact native publication attestation. The fingerprint
   * describes the bytes this reader verified, and is never accepted from a public request. */
  readSourceVersionMapping?(
    target: RecordedObservationTarget,
    archive: { recordingId: string; checksum: string; sizeBytes: number; content: Uint8Array }
  ): Promise<Readonly<Record<string, string>> | undefined>
}
export type RecordedObservationReader = {
  readBrowser(
    target: RecordedObservationTarget,
    signal?: AbortSignal
  ): Promise<RecordedBrowserPayload>
  readBrowserMedia(
    target: RecordedObservationTarget,
    mediaKey: string,
    signal?: AbortSignal
  ): Promise<{ body: Uint8Array; mimeType: string }>
  selectBrowserMoment(
    target: RecordedObservationTarget,
    offsetMs: number,
    signal?: AbortSignal
  ): Promise<BrowserRecordingMoment>
  read(target: RecordedObservationTarget, signal?: AbortSignal): Promise<RecordedObservationPayload>
  readMedia(
    target: RecordedObservationTarget,
    mediaKey: string,
    signal?: AbortSignal
  ): Promise<{ body: Uint8Array; mimeType: string }>
  readProject(
    target: RecordedObservationTarget,
    signal?: AbortSignal
  ): Promise<RecordedProjectPayload>
  readProjectMedia(
    target: RecordedObservationTarget,
    mediaKey: string,
    signal?: AbortSignal
  ): Promise<{ body: Uint8Array; mimeType: string }>
  selectFile(
    request: RecordedFileRequest,
    signal?: AbortSignal
  ): Promise<RecordedObservationFileSelection>
}
export class RecordedObservationReadError extends Error {
  readonly name = 'RecordedObservationReadError'
  constructor(
    readonly code: 'unavailable' | 'invalid-archive' | 'media-unavailable' | 'unauthorized'
  ) {
    super(
      {
        unavailable: 'The recorded observation is unavailable.',
        'invalid-archive': 'The recorded observation archive is invalid.',
        'media-unavailable': 'The recorded media is unavailable.',
        unauthorized: 'The recorded observation authorization is unavailable.'
      }[code]
    )
  }
}
const MAX_MEDIA_BYTES = 16 * 1024 * 1024
const MAX_CANDIDATES = 10000
const MAX_CONTEXT_RECEIPT_BYTES = 256 * 1024
const MAX_CONTEXT_RECEIPTS = 64
const MAX_CONTEXT_SCAN_BYTES = 2 * 1024 * 1024
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const checksum = (body: Uint8Array): string => createHash('sha256').update(body).digest('hex')
const sameInput = (left: NotebookRunInputFile, right: NotebookRunInputFile): boolean =>
  (
    [
      'inputFileVersionId',
      'sourceKind',
      'sourceFileId',
      'sourceProjectId',
      'sourceSessionId',
      'checksum',
      'sizeBytes',
      'storageKey'
    ] as const
  ).every((key) => left[key] === right[key])

/** Reads ordinary, published Artifacts. It never creates Runs, restores packages or starts services. */
export function createRecordedObservationReader(
  dependencies: RecordedObservationReaderDependencies
): RecordedObservationReader {
  const guard = async (target: RecordedObservationTarget, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted()
    try {
      await dependencies.authorizeScope({ ...target })
    } catch {
      throw new RecordedObservationReadError('unauthorized')
    }
    signal?.throwIfAborted()
  }
  const resolve = async (target: RecordedObservationTarget): Promise<NotebookRunInputFile> => {
    // No producerScope: unpublished versions must never be promoted to read authority here.
    const input = await dependencies.immutableInputAuthority.resolveVersion({
      projectId: target.projectId,
      sourceKind: 'artifact-version',
      expectedSourceFileId: target.artifactId,
      inputFileVersionId: target.versionId
    })
    if (
      !input ||
      input.sourceKind !== 'artifact-version' ||
      input.inputFileVersionId !== target.versionId ||
      input.sourceFileId !== target.artifactId ||
      input.sourceProjectId !== target.projectId ||
      input.sourceSessionId !== target.sessionId ||
      !/^[a-f0-9]{64}$/.test(input.checksum) ||
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes < 0
    )
      throw new RecordedObservationReadError('unavailable')
    return input
  }
  const readVersion = async (
    target: RecordedObservationTarget,
    limit: number,
    signal?: AbortSignal
  ): Promise<Uint8Array> => {
    await guard(target, signal)
    const input = await resolve(target)
    if (input.sizeBytes > limit) throw new RecordedObservationReadError('unavailable')
    const lease = await dependencies.immutableInputAuthority.openContent(input)
    try {
      await guard(target, signal)
      const body = await lease.readRange(0, input.sizeBytes)
      if (body.byteLength !== input.sizeBytes || checksum(body) !== input.checksum)
        throw new RecordedObservationReadError('unavailable')
      await lease.verifyUnchanged()
      // Disk identity alone does not prove the Artifact stayed published or in this Session.
      if (!sameInput(input, await resolve(target)))
        throw new RecordedObservationReadError('unavailable')
      await guard(target, signal)
      return body
    } finally {
      await lease.close()
    }
  }
  const load = async (
    target: RecordedObservationTarget,
    signal?: AbortSignal
  ): Promise<RecordedObservationPayload> => {
    const bytes = await readVersion(target, MAX_RUN_OBSERVATION_ARCHIVE_BYTES, signal)
    let archive: RunObservationArchive
    try {
      archive = parseRunObservationArchive(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      throw new RecordedObservationReadError('invalid-archive')
    }
    const candidates = await dependencies.projectFilesRepository.readExportFiles({
      projectId: target.projectId,
      sessionId: target.sessionId
    })
    if (candidates.length > MAX_CANDIDATES) throw new RecordedObservationReadError('unavailable')
    // Defend against a stale or over-broad repository adapter; no path, sender ID, or filename
    // alone can select content, and ambiguous matches remain absent from the resolved media.
    const permitted = candidates
      .filter(
        (candidate) =>
          candidate.source === 'artifact' &&
          candidate.projectId === target.projectId &&
          candidate.sessionId === target.sessionId &&
          candidate.originSession?.state !== 'deleted' &&
          candidate.originSession?.state !== 'deleting' &&
          candidate.checksum &&
          /^[a-f0-9]{64}$/.test(candidate.checksum) &&
          Number.isSafeInteger(candidate.size) &&
          candidate.size >= 0 &&
          candidate.size <= MAX_MEDIA_BYTES
      )
      .map((candidate) => ({
        sourceFileId: candidate.sourceFileId,
        sourceVersionId: candidate.sourceVersionId,
        projectId: candidate.projectId,
        sessionId: candidate.sessionId,
        name: candidate.name,
        checksum: candidate.checksum!,
        size: candidate.size
      }))
    const mapping = await dependencies.readSourceVersionMapping?.(
      { ...target },
      {
        recordingId: archive.recordingId,
        checksum: checksum(bytes),
        sizeBytes: bytes.byteLength,
        content: bytes
      }
    )
    // Native Artifact Run membership survives import remapping even when the JSON still carries
    // the author's IDs. Both the native relationship and exact recorded source Run must match.
    // A similarly named JSON file, or self-declared purpose alone, cannot identify a receipt.
    let executionContext = unknownExecutionContext()
    const descriptorReader = dependencies.artifactProvenanceRepository
    if (descriptorReader?.resolveVersionDescriptors) {
      const resolveDescriptors = (versionIds: string[]): Promise<ArtifactVersionDescriptor[]> =>
        descriptorReader.resolveVersionDescriptors!({
          projectId: target.projectId,
          appSessionId: target.sessionId,
          versionIds
        })
      const exact = (descriptor: ArtifactVersionDescriptor): boolean =>
        descriptor.projectId === target.projectId &&
        descriptor.sessionId === target.sessionId &&
        descriptor.state === 'finalized' &&
        descriptor.isPublished === true &&
        descriptor.originKind === 'agent_generated'
      const anchors = (await resolveDescriptors([target.versionId])).filter(
        (descriptor) =>
          exact(descriptor) &&
          descriptor.artifactId === target.artifactId &&
          descriptor.versionId === target.versionId &&
          descriptor.checksum === checksum(bytes) &&
          descriptor.size === bytes.byteLength &&
          descriptor.runId &&
          SAFE_ID.test(descriptor.runId)
      )
      if (anchors.length === 1) {
        const possible = candidates.filter(
          (candidate) =>
            candidate.source === 'artifact' &&
            candidate.projectId === target.projectId &&
            candidate.sessionId === target.sessionId &&
            candidate.sourceVersionId !== target.versionId &&
            candidate.originSession?.state !== 'deleted' &&
            candidate.originSession?.state !== 'deleting' &&
            candidate.mimeType === 'application/json' &&
            Number.isSafeInteger(candidate.size) &&
            candidate.size > 0 &&
            candidate.size <= MAX_CONTEXT_RECEIPT_BYTES
        )
        const related: ArtifactVersionDescriptor[] = []
        for (let start = 0; start < possible.length; start += 100) {
          await guard(target, signal)
          const batch = possible.slice(start, start + 100)
          related.push(
            ...(await resolveDescriptors(batch.map((item) => item.sourceVersionId))).filter(
              (descriptor) =>
                exact(descriptor) &&
                descriptor.runId === anchors[0].runId &&
                batch.some(
                  (item) =>
                    item.sourceFileId === descriptor.artifactId &&
                    item.sourceVersionId === descriptor.versionId &&
                    item.checksum === descriptor.checksum &&
                    item.size === descriptor.size
                )
            )
          )
        }
        // Refuse incomplete/ambiguous scans rather than selecting whichever receipt was seen first.
        if (
          related.length <= MAX_CONTEXT_RECEIPTS &&
          related.reduce((sum, item) => sum + item.size, 0) <= MAX_CONTEXT_SCAN_BYTES
        ) {
          const contexts: RunObservationExecutionContext[] = []
          for (const descriptor of related) {
            try {
              const content = await readVersion(
                { ...target, artifactId: descriptor.artifactId, versionId: descriptor.versionId },
                MAX_CONTEXT_RECEIPT_BYTES,
                signal
              )
              if (
                checksum(content) !== descriptor.checksum ||
                content.byteLength !== descriptor.size
              )
                continue
              const context = readCollectionExecutionContext(content, archive)
              if (context) contexts.push(context)
            } catch (error) {
              if (error instanceof RecordedObservationReadError && error.code === 'unauthorized')
                throw error
              await guard(target, signal)
              // Optional receipt damage must not hide an intact Replay. An incomplete scan also
              // must not choose a competing readable receipt, so retain unknown for this read.
              contexts.length = 0
              break
            }
          }
          const unique = new Map(contexts.map((context) => [JSON.stringify(context), context]))
          if (unique.size === 1) executionContext = [...unique.values()][0]
        }
      }
    }
    const historical = dependencies.artifactProvenanceRepository
    if (historical) {
      const contents = [
        ...new Map(
          archive.media
            .filter((media) => media.sizeBytes <= MAX_MEDIA_BYTES)
            .map((media) => [
              `${media.checksum}:${media.sizeBytes}`,
              { checksum: media.checksum, sizeBytes: media.sizeBytes }
            ])
        ).values()
      ]
      // A second import remaps the first receiver's IDs, while archive bytes still contain the
      // original author's IDs. Only receiving content membership survives every import hop.
      for (let start = 0; start < contents.length; start += 100) {
        await guard(target, signal)
        const batch = contents.slice(start, start + 100)
        const descriptors = await historical.resolvePublishedSessionVersionsByContent({
          projectId: target.projectId,
          appSessionId: target.sessionId,
          contents: batch
        })
        if (descriptors.length > 1000 || permitted.length + descriptors.length > MAX_CANDIDATES)
          throw new RecordedObservationReadError('unavailable')
        for (const descriptor of descriptors) {
          if (
            descriptor.projectId !== target.projectId ||
            descriptor.sessionId !== target.sessionId ||
            descriptor.state !== 'finalized' ||
            descriptor.isPublished !== true ||
            !SAFE_ID.test(descriptor.artifactId) ||
            !SAFE_ID.test(descriptor.versionId) ||
            !batch.some(
              (content) =>
                content.checksum === descriptor.checksum && content.sizeBytes === descriptor.size
            )
          )
            continue
          if (permitted.some((candidate) => candidate.sourceVersionId === descriptor.versionId))
            continue
          let input: NotebookRunInputFile
          try {
            input = await resolve({
              ...target,
              artifactId: descriptor.artifactId,
              versionId: descriptor.versionId
            })
          } catch (error) {
            if (error instanceof RecordedObservationReadError && error.code === 'unavailable')
              continue
            throw error
          }
          if (input.checksum !== descriptor.checksum || input.sizeBytes !== descriptor.size)
            continue
          // resolve() rechecks the exact Artifact/Version's publication and receiving scope.
          // The catalog-shaped entry carries no sender path or active runtime identity.
          permitted.push({
            sourceFileId: input.sourceFileId,
            sourceVersionId: input.inputFileVersionId,
            projectId: target.projectId,
            sessionId: target.sessionId,
            name: descriptor.name,
            checksum: input.checksum,
            size: input.sizeBytes
          })
        }
      }
    }
    const resolved = resolveRunObservationMedia(
      archive,
      target,
      permitted.map((candidate) => ({
        projectId: candidate.projectId,
        sessionId: candidate.sessionId,
        versionId: candidate.sourceVersionId,
        name: candidate.name,
        checksum: candidate.checksum!,
        sizeBytes: candidate.size,
        state: 'finalized',
        isPublished: true
      })),
      mapping
    )
    const media: ResolvedObservationMedia[] = []
    for (const result of resolved) {
      if (result.status !== 'available') continue
      const declared = archive.media.find((item) => item.mediaKey === result.mediaKey)!
      const contentIds = new Set(
        permitted
          .filter(
            (candidate) =>
              candidate.checksum === declared.checksum && candidate.size === declared.sizeBytes
          )
          .map((candidate) => candidate.sourceVersionId)
      )
      // Filenames can repeat or change across imports. Only a retained Main receipt may choose
      // one of several equally matching immutable versions, never the archive's name or ID alone.
      if (
        contentIds.size > 1 &&
        (!declared.sourceVersionId || mapping?.[declared.sourceVersionId] !== result.versionId)
      )
        continue
      const matches = permitted.filter(
        (candidate) => candidate.sourceVersionId === result.versionId
      )
      if (matches.length !== 1) continue
      const candidate = matches[0]
      media.push({
        mediaKey: result.mediaKey,
        artifactId: candidate.sourceFileId,
        versionId: candidate.sourceVersionId,
        checksum: candidate.checksum!,
        sizeBytes: candidate.size
      })
    }
    await resolve(target)
    await guard(target, signal)
    return { receiving: { ...target }, archive, media, executionContext }
  }
  const loadProjectLike = async (
    target: RecordedObservationTarget,
    signal?: AbortSignal,
    browser = false
  ): Promise<RecordedProjectPayload | RecordedBrowserPayload> => {
    const bytes = await readVersion(target, MAX_PROJECT_RECORDING_BYTES, signal)
    let recording: ProjectRecording | BrowserRecording
    try {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      recording = browser ? parseBrowserRecording(content) : parseProjectRecording(content)
    } catch {
      throw new RecordedObservationReadError('invalid-archive')
    }
    const files = await dependencies.projectFilesRepository.readExportFiles({
      projectId: target.projectId,
      sessionId: target.sessionId
    })
    if (files.length > MAX_CANDIDATES) throw new RecordedObservationReadError('unavailable')
    const candidates = new Map<
      string,
      { artifactId: string; versionId: string; checksum: string; sizeBytes: number }
    >()
    for (const file of files) {
      if (
        file.source !== 'artifact' ||
        file.projectId !== target.projectId ||
        file.sessionId !== target.sessionId ||
        ['deleted', 'deleting'].includes(file.originSession?.state ?? '') ||
        !file.checksum ||
        !/^[a-f0-9]{64}$/.test(file.checksum) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > MAX_MEDIA_BYTES
      )
        continue
      candidates.set(file.sourceVersionId, {
        artifactId: file.sourceFileId,
        versionId: file.sourceVersionId,
        checksum: file.checksum,
        sizeBytes: file.size
      })
    }
    const mapping = await dependencies.readSourceVersionMapping?.(target, {
      recordingId: recording.recordingId,
      checksum: checksum(bytes),
      sizeBytes: bytes.byteLength,
      content: bytes
    })
    const contents = [
      ...new Map(
        recording.media.map((item) => [
          `${item.checksum}:${item.sizeBytes}`,
          { checksum: item.checksum, sizeBytes: item.sizeBytes }
        ])
      ).values()
    ]
    const repository = dependencies.artifactProvenanceRepository
    if (repository)
      for (let start = 0; start < contents.length; start += 100) {
        await guard(target, signal)
        const batch = contents.slice(start, start + 100)
        const historical = await repository.resolvePublishedSessionVersionsByContent({
          projectId: target.projectId,
          appSessionId: target.sessionId,
          contents: batch
        })
        if (historical.length > 1000 || candidates.size + historical.length > MAX_CANDIDATES)
          throw new RecordedObservationReadError('unavailable')
        for (const file of historical) {
          if (
            file.projectId !== target.projectId ||
            file.sessionId !== target.sessionId ||
            file.state !== 'finalized' ||
            file.isPublished !== true ||
            !SAFE_ID.test(file.artifactId) ||
            !SAFE_ID.test(file.versionId) ||
            !batch.some((item) => item.checksum === file.checksum && item.sizeBytes === file.size)
          )
            continue
          candidates.set(file.versionId, {
            artifactId: file.artifactId,
            versionId: file.versionId,
            checksum: file.checksum,
            sizeBytes: file.size
          })
        }
      }
    const media: ResolvedObservationMedia[] = []
    for (const declared of recording.media) {
      const matching = [...candidates.values()].filter(
        (item) => item.checksum === declared.checksum && item.sizeBytes === declared.sizeBytes
      )
      const mapped = mapping?.[declared.sourceVersionId]
      const selected = mapped
        ? matching.find((item) => item.versionId === mapped)
        : matching.length === 1
          ? matching[0]
          : undefined
      if (!selected) continue
      try {
        const input = await resolve({
          ...target,
          artifactId: selected.artifactId,
          versionId: selected.versionId
        })
        if (input.checksum !== declared.checksum || input.sizeBytes !== declared.sizeBytes) continue
      } catch (error) {
        if (error instanceof RecordedObservationReadError && error.code === 'unavailable') continue
        throw error
      }
      media.push({ mediaKey: declared.mediaKey, ...selected })
    }
    await resolve(target)
    await guard(target, signal)
    return recording.format === 'open-science-web-recording'
      ? { receiving: { ...target }, recording, indexChecksum: checksum(bytes), media }
      : { receiving: { ...target }, recording, media }
  }
  const loadProject = async (
    target: RecordedObservationTarget,
    signal?: AbortSignal
  ): Promise<RecordedProjectPayload> => {
    const payload = await loadProjectLike(target, signal)
    if ('indexChecksum' in payload) throw new RecordedObservationReadError('invalid-archive')
    return payload
  }
  const loadBrowser = async (
    target: RecordedObservationTarget,
    signal?: AbortSignal
  ): Promise<RecordedBrowserPayload> => {
    const payload = await loadProjectLike(target, signal, true)
    if (!('indexChecksum' in payload)) throw new RecordedObservationReadError('invalid-archive')
    return payload
  }
  const mediaBytes = async (
    payload: RecordedObservationPayload | RecordedProjectPayload | RecordedBrowserPayload,
    mediaKey: string,
    signal?: AbortSignal
  ): Promise<{ body: Uint8Array; mimeType: string }> => {
    const source = 'archive' in payload ? payload.archive : payload.recording
    const declared = source.media.find((item) => item.mediaKey === mediaKey)
    const resolved = payload.media.find((item) => item.mediaKey === mediaKey)
    if (!declared || !resolved) throw new RecordedObservationReadError('media-unavailable')
    const body = await readVersion(
      { ...payload.receiving, artifactId: resolved.artifactId, versionId: resolved.versionId },
      MAX_MEDIA_BYTES,
      signal
    )
    if (body.byteLength !== declared.sizeBytes || checksum(body) !== declared.checksum)
      throw new RecordedObservationReadError('media-unavailable')
    await resolve(payload.receiving)
    await guard(payload.receiving, signal)
    return {
      body,
      mimeType: /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(declared.mimeType)
        ? declared.mimeType
        : 'application/octet-stream'
    }
  }
  const safe = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof RecordedObservationReadError) throw error
      throw new RecordedObservationReadError('unavailable')
    }
  }
  return {
    readBrowser: (target, signal) =>
      safe(() => loadBrowser(recordedObservationTargetSchema.parse(target), signal)),
    readBrowserMedia: (target, mediaKey, signal) =>
      safe(async () => {
        if (!SAFE_ID.test(mediaKey)) throw new RecordedObservationReadError('media-unavailable')
        return mediaBytes(
          await loadBrowser(recordedObservationTargetSchema.parse(target), signal),
          mediaKey,
          signal
        )
      }),
    selectBrowserMoment: (target, offsetMs, signal) =>
      safe(async () => {
        const payload = await loadBrowser(recordedObservationTargetSchema.parse(target), signal)
        if (!Number.isSafeInteger(offsetMs) || offsetMs < 0)
          throw new RecordedObservationReadError('media-unavailable')
        const segment = payload.recording.segments.find(
          (item) => offsetMs >= item.startMs && offsetMs < item.endMs
        )
        if (!segment) throw new RecordedObservationReadError('media-unavailable')
        const media = payload.recording.media.find((item) => item.mediaKey === segment.mediaKey)!
        const resolved = payload.media.find((item) => item.mediaKey === segment.mediaKey)
        if (!resolved) throw new RecordedObservationReadError('media-unavailable')
        await mediaBytes(payload, segment.mediaKey, signal)
        return browserRecordingMomentSchema.parse({
          kind: 'recorded-project-moment',
          selectionId: randomUUID(),
          selectedAt: Date.now(),
          receiving: payload.receiving,
          indexChecksum: payload.indexChecksum,
          recordingId: payload.recording.recordingId,
          offsetMs,
          segmentId: segment.segmentId,
          mediaKey: segment.mediaKey,
          segmentOffsetMs: offsetMs - segment.startMs,
          resource: {
            projectId: target.projectId,
            sessionId: target.sessionId,
            artifactId: resolved.artifactId,
            versionId: resolved.versionId,
            name: media.name,
            mimeType: media.mimeType,
            checksum: media.checksum,
            sizeBytes: media.sizeBytes
          }
        })
      }),
    read: (input, signal) => safe(() => load(recordedObservationTargetSchema.parse(input), signal)),
    readProject: (input, signal) =>
      safe(() => loadProject(recordedObservationTargetSchema.parse(input), signal)),
    readProjectMedia: (input, mediaKey, signal) =>
      safe(async () => {
        if (!SAFE_ID.test(mediaKey)) throw new RecordedObservationReadError('media-unavailable')
        return mediaBytes(
          await loadProject(recordedObservationTargetSchema.parse(input), signal),
          mediaKey,
          signal
        )
      }),
    selectFile: (input, signal) =>
      safe(async () => {
        const request = recordedFileRequestSchema.parse(input)
        const payload =
          request.format === 'project-recording'
            ? await loadProject(request.target, signal)
            : await load(request.target, signal)
        // A selection is concrete readable evidence, not just a catalog or claimed source Version.
        await mediaBytes(payload, request.mediaKey, signal)
        return {
          ...recordedFileSelectionForPayload(payload, request.mediaKey),
          selectionId: randomUUID(),
          selectedAt: Date.now()
        }
      }),
    readMedia: (input, mediaKey, signal) =>
      safe(async () => {
        const target = recordedObservationTargetSchema.parse(input)
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(mediaKey))
          throw new RecordedObservationReadError('media-unavailable')
        const payload = await load(target, signal)
        const resolved = payload.media.find((media) => media.mediaKey === mediaKey)
        const declared = payload.archive.media.find((media) => media.mediaKey === mediaKey)
        if (!resolved || !declared) throw new RecordedObservationReadError('media-unavailable')
        const body = await readVersion(
          { ...target, artifactId: resolved.artifactId, versionId: resolved.versionId },
          MAX_MEDIA_BYTES,
          signal
        )
        if (!verifyRunObservationMediaBytes(declared, body))
          throw new RecordedObservationReadError('media-unavailable')
        await resolve(target)
        await guard(target, signal)
        return {
          body,
          mimeType: /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(declared.mimeType)
            ? declared.mimeType
            : 'application/octet-stream'
        }
      })
  }
}
