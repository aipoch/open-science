import { readStoredImageTasks, withImageTaskSnapshot } from '../image-model/stored-tasks'
import { imageTaskIsActive, type ImageTaskScope, type ImageTask } from '../../shared/image-task'
import { readResearchFilmCard } from '../research-video/stored-presentation'
import { ReviewRepository } from '../reviewer/repository'
import { ComputeJobRepository } from '../compute/job-repository'
import type { ReplayRecords } from '@aipoch/research-film'
import {
  captureResearchFilms,
  appendResearchFilms,
  validateResearchFilms,
  type CapturedResearchFilms
} from './research-films'
import {
  researchFilmStorageKeys,
  packageFilms,
  type PackageModeFilms as PackageResearchFilms
} from './research-films-contract'
import type {
  ResearchVideoPresentationRequest,
  ResearchVideoPresentation
} from '../../shared/research-video-presentation'
import {
  withWorkingFileEvidenceRead,
  updateImportedEvidencePool,
  releaseImportedEvidenceProject
} from '../notebook/working-file-observer'
import type { PackageLiteratureSource } from './literature-source'
import {
  createLogger,
  diagnosticErrorFields,
  startDiagnosticOperation,
  type DiagnosticOperation
} from '@aipoch/diagnostics/node'
import { defaultFileDurability, writeDurableJsonFile } from '@aipoch/durable-files'
import type { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { BookmarkTarget } from '../../shared/bookmarks'
import type { NotebookRunDocument } from '../../shared/notebook'
import type {
  ListPdfAnnotationsRequest,
  PdfAnnotationListResult
} from '../../shared/pdf-annotations'
import {
  DEFAULT_PERMISSION_PROFILE,
  type PermissionProfileId
} from '../../shared/permission-profiles'
import { replayAnnotationTarget, splitReplayReferenceText } from '../../shared/replay-reference'
import type {
  PackageFileSelection,
  PackageProgress,
  PackageSelectableFile,
  PackageSelectionSummary
} from '../../shared/session-package'
import {
  PACKAGE_MAX_BYTES,
  PACKAGE_MAX_FILE_BYTES,
  PACKAGE_RO_CRATE_METADATA,
  sessionPackageImportRequestSchema,
  sessionPackageManifestSchema,
  sessionPackageReceiptSchema,
  sessionPackageRequestSchema,
  type SessionPackageImportRequest,
  type SessionPackageManifest,
  type SessionPackagePreview,
  type SessionPackageReceipt,
  type SessionPackageRequest
} from '../../shared/session-package'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { createManagedSessionWorkspaceCapability } from '../acp/managed-session-workspace'
import { sha256 } from '../artifacts/provenance-canonical'
import { resolveStorageKey } from '../artifacts/provenance-storage'
import { copySessionBookmarks, readSessionBookmarkTargets } from '../bookmarks/repository'
import {
  copyFileWithinBudget,
  digestFileWithinBudget,
  observeFile,
  sameFileObservation,
  type FileObservation
} from '../bounded-file-io'
import { paceFileIo } from '../file-io-pacing'
import { encodeRunDocumentDataPaths } from '../notebook/run-document-data-path-codec'
import { ensureWorkingFileEvidenceProject } from '../notebook/working-file-observer'
import type { PublishedSessionHandoff } from '../session-persistence/coordinator'
import { SessionProjectionRepository } from '../session-persistence/projection'
import { SessionRepository, loadSessionMutationAuthority } from '../session-persistence/repository'
import { encodeSessionDataPaths } from '../session-persistence/session-data-paths'
import { decodeDataPath, encodeDataPath } from '../storage/data-path'
import { isSessionPackagePending } from '../storage/session-package-state'
import { publishUserFile } from '../user-file-publisher'
import {
  assertPackageSourcePath,
  fileChecksum,
  packageEntry,
  readPackageJson,
  validatePackageDirectory,
  writePackageArchive
} from './archive'
import { assertPackageCapacity } from './capacity'
import { createPackageContentVerifier } from './materialize'
import { PackageCleanupPendingError, withPackageCleanup } from './cleanup'
import { SessionPackageDeletion } from './deletion'
import {
  collectPackageLogEvidence,
  executionEvidenceKeys,
  hasComputeLogEvidence,
  inheritedComputeChecksums
} from './execution-evidence'
import { ForkRecoveryRequiredError, createForkSession, nextForkTitle } from './fork-session'
import { preserveLocalForkWebEvidence } from '../web/fork-evidence'
import { capturePackageHistory, type PackageHistory } from './history'
import { assertSettledHistory, inspectSessionPackage, preview, readSession } from './inspection'
import {
  capturePackageLiterature,
  sessionLiteratureReferences,
  validatePackageLiteratureSession
} from './literature'
import {
  captureNativeRecords,
  mapPackageReferences,
  nativeStorageKeys,
  notebookDocumentIdentity,
  notebookStorageKeys,
  parseNativeRecords,
  prepareNativeImport,
  logIdentityPlanSchema,
  type LogIdentityPlan,
  prepareNativePublication,
  readPackageNotebooks,
  remapStorageKey,
  sessionFileVersionIds
} from './native-snapshot'
import {
  capturePackagePdfNotes,
  filterPackagePdfNotes,
  namespacePackagePdfNotes,
  readPackagePdfSource,
  retainInheritedPdfNotes
} from './pdf-notes'
import type { PackagePdfNotes } from './pdf-notes-contract'
import type { PackageRecords } from './records-contract'
import {
  capturePackageReproducibility,
  installPackageReproducibility,
  packageReproducibilityExclusions,
  packageReproducibilityKeys
} from './reproducibility'
import { writePackageRoCrateMetadata } from './ro-crate'
import {
  assertNoExcludedContentCopies,
  excludedNotebookInputCopy,
  isNotebookInputCopy,
  markRequiredPackageFiles,
  selectablePackageFiles,
  validateExcludedFiles
} from './selection'
import {
  PackageSensitiveContentError,
  PackageTextScanner,
  buildSensitiveContentEvidence,
  findSensitivePackageText,
  isPrivatePackageField,
  type PackageSensitiveContentSource
} from './sensitive-content'
import { withPackageTransfer } from './transfer'
import { assertPortablePackageStorageKey, validatePackageRecords } from './validation'
import {
  assertWebDerivedTextSafe,
  containsShortWebContent,
  prepareWebEvidence,
  projectWebDerivedValue,
  remapWebEvidence,
  type PrepareWebEvidenceOptions,
  type WebEvidenceProjection,
  type WebPackageActivity,
  type WebSnapshotInput
} from './web-evidence'

const activeLogImports = new Set<string>()
const importJournalSchema = sessionPackageRequestSchema
  .extend({
    schemaVersion: z.literal(1),
    retryPlanName: z
      .string()
      .regex(/^[a-f0-9]{64}\.json$/u)
      .optional(),
    directories: z
      .array(
        z
          .object({
            scope: z.enum([
              'artifacts',
              'uploads',
              'notebooks',
              'execution-file-evidence',
              'notebook-file-evidence',
              'file-evidence'
            ]),
            sessionId: sessionPackageRequestSchema.shape.sessionId
          })
          .strict()
      )
      .max(10000)
  })
  .strict()
type ImportJournal = z.infer<typeof importJournalSchema>

// A native commit may already exist. Desktop retries this handle instead of importing new bytes.
export class PackageImportRecoveryRequiredError extends Error {
  constructor(
    readonly identity: SessionPackageRequest,
    readonly resume: (signal?: AbortSignal) => Promise<SessionPackageRequest | undefined>,
    cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : 'Session package import recovery failed.', {
      cause
    })
  }
}

const PACKAGE_README =
  '# Open-Science Session package\n\nOpen-Science can inspect and import this archive as read-only research history. Import does not execute code or restore account credentials. Checksums verify bytes, not scientific claims or the identity of the sender.\n'

type PackageOptions = {
  webEvidence?: Pick<PrepareWebEvidenceOptions, 'resolvePolicy'> & {
    loadSnapshot?: (
      session: PersistedChatSession,
      snapshotId: string,
      activity: WebPackageActivity
    ) => Promise<WebSnapshotInput | undefined>
  }
  literatureSource?: PackageLiteratureSource
  storageRoot: string
  configRoot?: string
  getDefaultPermissionProfile?: () => Promise<PermissionProfileId>
  getClient: () => Promise<PrismaClient>
  isSessionActive?: (projectId: string, sessionId: string) => boolean
  reserveExport?: (request: SessionPackageRequest, signal: AbortSignal) => Promise<() => void>
  readImageTasks?: (scope: ImageTaskScope) => Promise<ImageTask[]>
  inspectPackage?: typeof inspectSessionPackage
  runSessionPublication?: (
    projectId: string,
    sessionId: string,
    work: () => Promise<PersistedChatSession>
  ) => Promise<PersistedChatSession>
  onSessionPublished?: (publication: PublishedSessionHandoff) => Promise<void>
  onForkPrepared?: (source: PersistedChatSession, child: PersistedChatSession) => Promise<void>
  onForkAborted?: (child: PersistedChatSession) => Promise<void>
}

type PackageExportOptions = {
  // Per-attempt policy; the desktop owner requires explicit acknowledgement of a failed export.
  allowSensitiveContent?: boolean
  selectFiles?: (
    files: PackageSelectableFile[],
    signal: AbortSignal,
    summary: PackageSelectionSummary,
    title: string
  ) => Promise<readonly string[] | PackageFileSelection>
  signal?: AbortSignal
  onProgress?: (progress: PackageProgress) => void
}

type PackageSnapshotOptions = PackageExportOptions & {
  // Local-copy consumer: no archive, picker, or sharing-policy boundary.
  consumeSnapshot?: (directory: string) => Promise<void>
}

class WebPackagePolicyError extends Error {
  readonly code = 'WEB_PACKAGE_POLICY_RESTRICTED'
  constructor(
    cause?: unknown,
    readonly invocationIds: readonly string[] = []
  ) {
    super('Required Web execution evidence cannot be shared under the current data policy.', {
      cause
    })
  }
}

// Execution IDs identify copies of short queries. A long exact restricted body/excerpt also
// identifies an untagged echo; ordinary short prose cannot restrict an unrelated Artifact.
const assertWebShareableFile = async (
  path: string,
  projection: WebEvidenceProjection | undefined,
  signal: AbortSignal
): Promise<void> => {
  if (!projection) return
  let tail = ''
  let decoder: TextDecoder | undefined
  let seenEnvelope = false
  let seenHostFlag = false
  let seenHostWebIdentity = false
  let seenRawExecutionField = false
  const seenInvocations = new Set<string>()
  const seenRestricted = new Set<string>()
  const seenAttributableRestricted = new Set<string>()
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024, signal })) {
    await paceFileIo(chunk.length, signal)
    signal.throwIfAborted()
    decoder ??= new TextDecoder(
      chunk[0] === 0xff && chunk[1] === 0xfe
        ? 'utf-16le'
        : chunk[0] === 0xfe && chunk[1] === 0xff
          ? 'utf-16be'
          : 'utf-8'
    )
    const text = tail + decoder.decode(chunk, { stream: true })
    seenEnvelope ||= /open-science\.web\.v[123]\b/.test(text)
    seenHostFlag ||= /"appOwned"\s*:\s*true\b/.test(text)
    seenRawExecutionField ||=
      /"(?:rawInput|rawOutput|toolContent|terminalOutput|toolLocations)"\s*:/.test(text)
    seenHostWebIdentity ||=
      /"providerToolName"\s*:\s*"(?:mcp__open_science_web__web_(?:fetch|search)|mcp__open-science-web__web_(?:fetch|search)|open-science-web\/web_(?:fetch|search))"/.test(
        text
      )
    if (seenHostFlag && seenHostWebIdentity && seenRawExecutionField)
      throw new WebPackagePolicyError()
    for (const id of new Set([
      ...projection.plan.packets.keys(),
      ...projection.plan.restrictedText.keys()
    ]))
      if (text.includes(id)) seenInvocations.add(id)
    for (const [id, restricted] of projection.plan.restrictedText) {
      const matched = restricted.filter((value) => {
        let prefix = value.slice(0, 16 * 1024)
        const nextUnit = value.charCodeAt(prefix.length)
        if (/[\uD800-\uDBFF]$/.test(prefix) && nextUnit >= 0xdc00 && nextUnit <= 0xdfff)
          prefix = prefix.slice(0, -1)
        return (
          prefix.length > 0 &&
          (text.includes(prefix) || text.includes(JSON.stringify(prefix).slice(1, -1)))
        )
      })
      if (matched.length) seenRestricted.add(id)
      if (
        containsShortWebContent(text, projection.plan, id) ||
        matched.some((value) => value.length >= 32 || text.trim() === value.trim())
      )
        seenAttributableRestricted.add(id)
    }
    if (seenEnvelope && seenInvocations.size)
      throw new WebPackagePolicyError(undefined, [...seenInvocations])
    const paired = [...seenRestricted].filter(
      (id) => seenInvocations.has(id) || seenAttributableRestricted.has(id)
    )
    if (paired.length) throw new WebPackagePolicyError(undefined, paired)
    try {
      assertWebDerivedTextSafe(text, projection.plan)
    } catch (error) {
      throw new WebPackagePolicyError(error, [...seenInvocations])
    }
    tail = text.slice(-128 * 1024)
  }
}

const noteWebPolicyOmission = (
  projection: WebEvidenceProjection,
  invocationIds: readonly string[]
): void => {
  const packets = invocationIds.length
    ? invocationIds.flatMap((id) => projection.plan.packets.get(id) ?? [])
    : [...projection.plan.packets.values()]
  for (const component of new Set(
    packets.map((packet) =>
      packet.operation === 'fetch' ? ('fetch_body' as const) : ('provider_excerpt' as const)
    )
  )) {
    const existing = projection.omissions.find(
      (item) => item.component === component && item.reason === 'redacted'
    )
    if (existing) existing.count = Math.min(100000, existing.count + 1)
    else projection.omissions.push({ component, reason: 'redacted', count: 1 })
  }
}

const webPolicyExcludedFiles = async (
  files: readonly PackageSelectableFile[],
  sourcePath: (file: PackageSelectableFile) => Promise<string>,
  projection: WebEvidenceProjection | undefined,
  signal: AbortSignal
): Promise<Set<string>> => {
  const excluded = new Set<string>()
  if (!projection) return excluded
  for (const file of files) {
    const path = await sourcePath(file)
    try {
      await assertWebShareableFile(path, projection, signal)
    } catch (error) {
      if (!(error instanceof WebPackagePolicyError) || file.requiredForEvidence) throw error
      excluded.add(file.storageKey)
      noteWebPolicyOmission(projection, error.invocationIds)
    }
  }
  return excluded
}

const projectWebSessionCopies = (projection: WebEvidenceProjection): PersistedChatSession => {
  const { activities, conversationGraph, ...rest } = projection.session
  const projected = projectWebDerivedValue(rest, projection.plan)
  if (!conversationGraph) return { ...projected, activities }
  const { activities: graphActivities, ...graph } = conversationGraph
  return {
    ...projected,
    activities,
    conversationGraph: {
      ...projectWebDerivedValue(graph, projection.plan),
      activities: graphActivities
    }
  }
}

const omittedWebLogLanes = new WeakMap<WebEvidenceProjection, Set<string>>()
const projectWebRecords = (
  records: PackageRecords,
  projection: WebEvidenceProjection | undefined
): PackageRecords => {
  if (!projection) return records
  // These records seal scientific evidence. Never change their bytes while retaining a hash.
  for (const value of [
    records.tables,
    records.reproducibility,
    records.pdfNotes,
    records.literature,
    records.researchFilms,
    records.operationReplayFilms,
    records.imageTasks
  ]) {
    if (!value) continue
    try {
      assertWebDerivedTextSafe(JSON.stringify(value), projection.plan)
    } catch (error) {
      throw new WebPackagePolicyError(error)
    }
  }
  const logEvidence = records.logEvidence?.filter((lane) => {
    try {
      assertWebDerivedTextSafe(JSON.stringify(lane), projection.plan)
      return true
    } catch {
      const omitted = omittedWebLogLanes.get(projection) ?? new Set<string>()
      if (!omitted.has(lane.key)) {
        noteWebPolicyOmission(
          projection,
          [...projection.plan.packets.keys()].filter((id) => JSON.stringify(lane).includes(id))
        )
        omitted.add(lane.key)
        omittedWebLogLanes.set(projection, omitted)
      }
      return false
    }
  })
  return {
    ...records,
    history: projectWebDerivedValue(records.history, projection.plan),
    logEvidence: logEvidence?.length ? logEvidence : undefined,
    webEvidence: projection.webEvidence
  }
}

// Session links refer to local snapshots, so portable history retains their readable labels only.
const portableMessage = <T extends PersistedChatSession['messages'][number]>(message: T): T => {
  const clean = (text: string): string =>
    splitReplayReferenceText(text)
      .map((part) =>
        part.kind === 'text' ? part.text : `${part.label} (local Session link omitted)`
      )
      .join('')
  const annotations = message.annotations?.filter(
    (annotation) => !replayAnnotationTarget(annotation)
  )
  const quotes =
    message.annotations
      ?.filter((annotation) => replayAnnotationTarget(annotation))
      .map((annotation) => (annotation.kind === 'text' ? annotation.quote : ''))
      .filter(Boolean) ?? []
  return {
    ...message,
    content: [clean(message.content), ...quotes].filter(Boolean).join('\n\n'),
    annotations,
    parts: message.parts
      ? [
          ...message.parts.map((part) =>
            part.type === 'text' ? { ...part, text: clean(part.text) } : part
          ),
          ...(quotes.length ? [{ type: 'text' as const, text: `\n\n${quotes.join('\n\n')}` }] : [])
        ]
      : undefined
  }
}

// Strip only known private or auxiliary runtime metadata. Delivered Side Chat relays already live
// in the main conversation graph and remain exportable; the auxiliary transcripts and queue do not.
// A similarly named key inside research evidence must still be inspected and rejected when
// sensitive, never silently removed from the evidence.
const withoutPrivateAuthority = (session: PersistedChatSession): PersistedChatSession => ({
  ...session,
  parentSessionId: undefined,
  deletedDiscussionSourceId: undefined,
  messages: session.messages.map(portableMessage),
  conversationGraph: session.conversationGraph
    ? {
        ...session.conversationGraph,
        messages: session.conversationGraph.messages.map(portableMessage)
      }
    : undefined,
  promptPreparation: undefined,
  providerSessionId: undefined,
  providerContinuityToken: undefined,
  runtimeContext: session.runtimeContext
    ? {
        ...session.runtimeContext,
        permission: undefined,
        networkApprovals: undefined,
        sideChat: undefined,
        sideChats: undefined,
        sideChatRelays: undefined,
        // Local reading links are not part of a portable Session package.
        sessionContext: undefined
      }
    : undefined
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const requiresPrivateAuthorityRemoval = (envelope: unknown): boolean => {
  if (!isRecord(envelope)) return false
  const hasEnvelopeField = Object.hasOwn(envelope, 'version') || Object.hasOwn(envelope, 'session')
  const session = hasEnvelopeField ? envelope.session : envelope
  if (!isRecord(session)) return false
  if (
    Object.hasOwn(session, 'parentSessionId') ||
    Object.hasOwn(session, 'deletedDiscussionSourceId') ||
    Object.hasOwn(session, 'promptPreparation') ||
    Object.hasOwn(session, 'providerSessionId') ||
    Object.hasOwn(session, 'providerContinuityToken')
  )
    return true
  if (JSON.stringify(session).includes('session-replay:')) return true
  const runtimeContext = session.runtimeContext
  return (
    isRecord(runtimeContext) &&
    [
      'permission',
      'networkApprovals',
      'sideChat',
      'sideChats',
      'sideChatRelays',
      'sessionContext'
    ].some((key) => Object.hasOwn(runtimeContext, key))
  )
}

const exportRelevantSession = (session: PersistedChatSession): PersistedChatSession => {
  // The persistence export reservation admits only Side Chat projection writes. Those fields are
  // excluded above, but their save still advances Session/runtime revisions and the active branch's
  // derived timestamp; normalize that bookkeeping while keeping exported research state strict.
  const shared = withoutPrivateAuthority(session)
  const hasRuntimeState =
    shared.runtimeContext &&
    Object.entries(shared.runtimeContext).some(
      ([key, value]) => key !== 'version' && key !== 'revision' && value !== undefined
    )
  return {
    ...shared,
    revision: undefined,
    updatedAt: 0,
    runtimeContext:
      hasRuntimeState && shared.runtimeContext
        ? { ...shared.runtimeContext, revision: 0 }
        : undefined,
    conversationGraph: shared.conversationGraph
      ? {
          ...shared.conversationGraph,
          branches: shared.conversationGraph.branches.map((branch) => ({
            ...branch,
            updatedAt: 0
          }))
        }
      : undefined
  }
}

// Recognizers stop export; they never silently rewrite research text. File preview is still
// necessary: arbitrary binary research data cannot be certified free of private information.
function* inspectShareable(value: unknown, location: string): Generator<number> {
  if (typeof value === 'string') {
    const match = findSensitivePackageText(value)
    if (match)
      throw new PackageSensitiveContentError(
        `${location} @${match.offset}`,
        match.rule,
        buildSensitiveContentEvidence(value, match, `${location} @${match.offset}`)
      )
    yield value.length + 1
  } else if (Array.isArray(value)) {
    yield 1
    for (const [index, item] of value.entries())
      yield* inspectShareable(item, `${location}[${index}]`)
  } else if (value && typeof value === 'object') {
    yield 1
    for (const [index, [key, item]] of Object.entries(value).entries()) {
      const child = `${location}[entry ${index}]`
      if (typeof item === 'string' && isPrivatePackageField(key, item))
        throw new PackageSensitiveContentError(
          child,
          'field',
          buildSensitiveContentEvidence(
            `${key}: ${item}`,
            { offset: key.length + 2, length: item.length, rule: 'field', label: key },
            child
          )
        )
      yield key.length
      yield* inspectShareable(item, child)
    }
  } else {
    yield 1
  }
}

const assertShareable = async (
  value: unknown,
  signal?: AbortSignal,
  location = 'metadata'
): Promise<void> => {
  signal?.throwIfAborted()
  let work = 0
  for (const units of inspectShareable(value, location)) {
    work += units
    // Budget UTF-16 code units and visited nodes, not physical I/O. Keep each value whole:
    // splitting recognizer input could miss credentials, so one large string remains atomic.
    if (work >= 64 * 1024) {
      await yieldToEventLoop()
      signal?.throwIfAborted()
      work = 0
    }
  }
}

const assertShareableFile = async (
  path: string,
  signal?: AbortSignal,
  location = 'file',
  sourceStorageKey?: string,
  source?: PackageSensitiveContentSource
): Promise<void> => {
  // Classify actual bytes, including extensionless evidence. UTF-16 is text when identified
  // by its BOM. PDF is a container even when all its bytes happen to be valid UTF-8.
  // Binary/archived content is not certified free of private information.
  let decoder: TextDecoder | undefined
  const scanner = new PackageTextScanner()
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024, signal })) {
    await paceFileIo(chunk.length, signal)
    signal?.throwIfAborted()
    if (!decoder) {
      if (chunk.subarray(0, 5).toString('ascii') === '%PDF-') return
      const encoding =
        chunk[0] === 0xff && chunk[1] === 0xfe
          ? 'utf-16le'
          : chunk[0] === 0xfe && chunk[1] === 0xff
            ? 'utf-16be'
            : 'utf-8'
      decoder = new TextDecoder(encoding, { fatal: true })
    }
    let decoded: string
    try {
      decoded = decoder.decode(chunk, { stream: true })
    } catch {
      return
    }
    if (decoded.includes('\0')) return
    // Do not reject a text-like prefix before the remainder has been classified.
    scanner.write(decoded)
  }
  signal?.throwIfAborted()
  let final = ''
  try {
    final = decoder?.decode() ?? ''
  } catch {
    return
  }
  scanner.write(final)
  const finding = scanner.finish()
  if (finding) {
    const { text, match, offset } = finding
    const at = `${location} @${offset + match.offset}`
    throw new PackageSensitiveContentError(
      at,
      match.rule,
      buildSensitiveContentEvidence(text, match, at, sourceStorageKey, offset),
      source
    )
  }
}

export class SessionPackageService {
  // Imports and recovery share one owner. A recovery call must never reap live staging.
  private operationTail: Promise<unknown> = Promise.resolve()
  private queuedOperations = 0
  private closed = false
  private readonly shutdown = new AbortController()
  private signal = this.shutdown.signal
  private readonly deletion: SessionPackageDeletion
  constructor(readonly options: PackageOptions) {
    this.deletion = new SessionPackageDeletion({
      ...options,
      configRoot: options.configRoot ?? options.storageRoot
    })
  }

  async prepareSessionDeletion(session: PersistedChatSession): Promise<void> {
    if (!session.packageOrigin && !session.forkOrigin) return
    let origin: Awaited<ReturnType<SessionPackageService['readOrigin']>>
    let receipt: SessionPackageReceipt
    try {
      origin = await this.readOrigin({ projectId: session.projectId, sessionId: session.id })
      receipt = sessionPackageReceiptSchema.parse(
        await readPackageJson(
          join(
            this.options.storageRoot,
            'artifacts',
            session.projectId,
            session.id,
            session.forkOrigin ? '.session-fork' : '.session-package',
            'receipt.json'
          )
        )
      )
    } catch (error) {
      createLogger('session-package').warn(
        'Unverifiable imported evidence retained during Session deletion',
        diagnosticErrorFields(error)
      )
      // Durable intent write failures still reject deletion, including the conservative path.
      await this.deletion.prepareRetained(session)
      return
    }
    await this.deletion.prepare(session, receipt, origin.originSessionIds, origin.logSessionIds)
  }

  private serialize<Result>(work: () => Promise<Result>, signal?: AbortSignal): Promise<Result> {
    if (this.closed) return Promise.reject(new Error('Session package service is closed.'))
    this.queuedOperations++
    const result = this.operationTail.then(() =>
      withPackageTransfer(async (transfer) => {
        this.shutdown.signal.throwIfAborted()
        this.signal = AbortSignal.any([
          this.shutdown.signal,
          transfer.signal,
          ...(signal ? [signal] : [])
        ])
        this.signal.throwIfAborted()
        return work()
      })
    )
    const settled = result.finally(() => {
      this.queuedOperations--
    })
    this.operationTail = settled.then(
      () => undefined,
      () => undefined
    )
    return settled
  }

  /** Film retirement shares export's queue so a captured package source cannot disappear. */
  withFilmRetention(work: () => Promise<boolean>): Promise<boolean> {
    return this.queuedOperations ? Promise.resolve(false) : this.serialize(work)
  }

  private async waitForUser<T>(work: () => Promise<T>): Promise<T> {
    this.signal.throwIfAborted()
    const result = await withPackageTransfer((transfer) => transfer.waitForUser(work))
    this.signal.throwIfAborted()
    return result
  }

  private async chooseFiles(
    options: PackageExportOptions,
    files: PackageSelectableFile[],
    summary: PackageSelectionSummary,
    title: string
  ): Promise<PackageFileSelection> {
    if (files.length > 10000 || summary.retainedFiles.length > 10000)
      throw new Error('Session package exceeds the file count limit.')
    const selected = options.selectFiles
      ? await this.waitForUser(() => options.selectFiles!(files, this.signal, summary, title))
      : []
    const selection: PackageFileSelection =
      'excludedStorageKeys' in selected
        ? selected
        : { excludedStorageKeys: selected, includePdfNotes: false }
    const excluded = selection.excludedStorageKeys
    const keys = new Set(excluded)
    if (files.some((file) => file.requiredForEvidence && keys.has(file.storageKey)))
      throw new Error(
        'An excluded file also exists in retained research evidence. Include that file to export this Session.'
      )
    return selection
  }

  async close(): Promise<void> {
    this.closed = true
    this.shutdown.abort(new Error('Session package service is closed.'))
    await this.operationTail
  }

  private get configRoot(): string {
    return this.options.configRoot ?? this.options.storageRoot
  }

  // Recovery writes must finish before the surface reserves/freeze-locks the Session.
  async prepareExport(request: SessionPackageRequest): Promise<void> {
    if (!this.options.readImageTasks) return
    const safe = sessionPackageRequestSchema.parse(request)
    const loaded = await loadSessionMutationAuthority(
      new SessionRepository(this.configRoot),
      safe.projectId,
      safe.sessionId
    )
    // Imported history is immutable; its source task states must not be recovered as local work.
    if (loaded.status === 'found' && !loaded.session.packageOrigin)
      await this.options.readImageTasks(safe)
  }

  async assertExportIdle(request: SessionPackageRequest): Promise<void> {
    const safe = sessionPackageRequestSchema.parse(request)
    const loaded = await loadSessionMutationAuthority(
      new SessionRepository(this.configRoot),
      safe.projectId,
      safe.sessionId
    )
    if (loaded.status !== 'found') throw new Error('Session not found or unreadable.')
    if (!loaded.session.packageOrigin) assertSettledHistory(loaded.session)
    if (this.options.isSessionActive?.(safe.projectId, safe.sessionId))
      throw new Error('The Session is still active.')
  }

  exportTo(
    rawRequest: SessionPackageRequest,
    path: string,
    options: PackageExportOptions = {}
  ): Promise<SessionPackagePreview> {
    return this.serialize(
      () =>
        this.withExportReservation(rawRequest, (request) => this.exportNow(request, path, options)),
      options.signal
    )
  }

  private async withExportReservation<Result>(
    rawRequest: SessionPackageRequest,
    work: (request: SessionPackageRequest) => Promise<Result>
  ): Promise<Result> {
    const request = sessionPackageRequestSchema.parse(rawRequest)
    const release = await this.options.reserveExport?.(request, this.signal)
    try {
      this.signal.throwIfAborted()
      await this.assertExportIdle(request)
      return await work(request)
    } finally {
      release?.()
    }
  }

  private async exportNow(
    rawRequest: SessionPackageRequest,
    path: string,
    options: PackageSnapshotOptions
  ): Promise<SessionPackagePreview> {
    const request = sessionPackageRequestSchema.parse(rawRequest)
    // These internal phases are log evidence only, independent of the UI's coarse progress.
    // Never include source paths, filenames, content or arbitrary exception messages.
    const diagnostic = startDiagnosticOperation(createLogger('session-package'), {
      operation: 'session-package.export-snapshot',
      fields: { projectId: request.projectId, sessionId: request.sessionId }
    })
    diagnostic.phase('wait-for-evidence')
    try {
      const result = await withWorkingFileEvidenceRead(
        this.options.storageRoot,
        request.projectId,
        () => withImageTaskSnapshot(() => this.exportSnapshot(request, path, options, diagnostic))
      )
      diagnostic.complete()
      return result
    } catch (error) {
      if (this.signal.aborted) diagnostic.cancel()
      else diagnostic.fail(error)
      throw error
    }
  }

  private async exportSnapshot(
    request: SessionPackageRequest,
    path: string,
    options: PackageSnapshotOptions,
    diagnostic: DiagnosticOperation
  ): Promise<SessionPackagePreview> {
    diagnostic.phase('load-session')
    const sessions = new SessionRepository(this.configRoot)
    const loaded = await loadSessionMutationAuthority(
      sessions,
      request.projectId,
      request.sessionId
    )
    if (loaded.status !== 'found') throw new Error('Session not found or unreadable.')
    if (!loaded.session.packageOrigin) assertSettledHistory(loaded.session)
    // Remove local selectors before collecting annotation file dependencies as well.
    const session = withoutPrivateAuthority(loaded.session)
    const filmOrigin =
      session.packageOrigin || session.forkOrigin ? await this.readOrigin(request) : undefined
    const capturedFilms = await captureResearchFilms(
      this.options.storageRoot,
      session,
      mapPackageReferences(
        filmOrigin?.researchFilms ?? [],
        filmOrigin?.identities ?? {}
      ) as PackageResearchFilms,
      this.signal,
      new Map(filmOrigin?.files.map((file) => [file.localStorageKey, file.localChecksum]))
    )
    const filmSummary = capturedFilms.films.length
      ? {
          count: capturedFilms.films.length,
          sizeBytes: [...capturedFilms.files.values()].reduce(
            (sum, file) => sum + file.sizeBytes,
            0
          )
        }
      : undefined
    const appendFilms = async (
      directory: string,
      records: PackageRecords,
      manifest: SessionPackageManifest,
      captured = capturedFilms,
      webProjection?: WebEvidenceProjection
    ): Promise<void> => {
      await appendResearchFilms({
        root: this.options.storageRoot,
        directory,
        records,
        manifest,
        captured,
        signal: this.signal,
        onProgress: options.onProgress,
        checkFile: async (path, storageKey, checksum) => {
          await assertWebShareableFile(path, webProjection, this.signal)
          if (!options.consumeSnapshot && !options.allowSensitiveContent)
            await assertShareableFile(path, this.signal, storageKey, storageKey, {
              storageKey,
              root: directory,
              relativePath: `objects/${checksum}`,
              checksum
            })
        }
      })
      if (!options.consumeSnapshot && !options.allowSensitiveContent)
        await assertShareable(records, this.signal, 'records.json')
    }
    if (session.packageOrigin && !filmOrigin?.nativeLogOrigin) {
      diagnostic.phase('validate-retained-package')
      if (this.options.isSessionActive?.(request.projectId, request.sessionId))
        throw new Error('The Session is still active.')
      // Forward the retained source package, never relabel locally derived hashes as original.
      const origin = filmOrigin!
      const source = join(
        this.options.storageRoot,
        'artifacts',
        request.projectId,
        request.sessionId,
        '.session-package',
        'source'
      )
      const manifest = await validatePackageDirectory(
        source,
        this.signal,
        undefined,
        undefined,
        new Set(researchFilmStorageKeys(origin.researchFilms))
      )
      if (manifest.source.projectId !== origin.sourceManifest.source.projectId)
        throw new Error('Session package source identity mismatch.')
      if (!options.consumeSnapshot && !options.allowSensitiveContent)
        await assertShareable(manifest, this.signal, 'manifest.json')
      const sourceSessionEnvelope = await readPackageJson(join(source, 'session.json'))
      const sourceSession = await readSession(source)
      let forwardedSession = withoutPrivateAuthority(
        options.consumeSnapshot
          ? (mapPackageReferences(
              encodeSessionDataPaths(session, this.options.storageRoot),
              Object.fromEntries(
                Object.entries(origin.identities).map(([oldId, localId]) => [localId, oldId])
              )
            ) as PersistedChatSession)
          : sourceSession
      )
      const sourceRecords = parseNativeRecords(await readPackageJson(join(source, 'records.json')))
      const forwardedWeb = await this.prepareWebProjection(
        forwardedSession,
        options,
        sourceRecords.webEvidence
      )
      if (forwardedWeb) forwardedSession = projectWebSessionCopies(forwardedWeb)
      const records = projectWebRecords(sourceRecords, forwardedWeb)
      if (!options.consumeSnapshot && !options.allowSensitiveContent)
        await assertShareable(forwardedSession, this.signal, 'session.json')
      // Inspect the raw envelope so malformed legacy Side Chat data dropped by the Session
      // sanitizer cannot bypass the rewrite and be copied into the forwarded package.
      const forwardedSessionJson =
        options.consumeSnapshot ||
        forwardedWeb ||
        requiresPrivateAuthorityRemoval(sourceSessionEnvelope)
          ? JSON.stringify({ version: 2, session: forwardedSession })
          : undefined
      const previousFilmKeys = new Set(researchFilmStorageKeys(packageFilms(records)))
      delete records.researchFilms
      delete records.operationReplayFilms
      const inverseIds = Object.fromEntries(
        Object.entries(origin.identities).map(([oldId, localId]) => [localId, oldId])
      )
      const forwardedFilms: CapturedResearchFilms = {
        films: mapPackageReferences(capturedFilms.films, inverseIds) as PackageResearchFilms,
        files: new Map(
          [...capturedFilms.files].map(([key, file]) => [remapStorageKey(key, inverseIds), file])
        )
      }
      if (!options.consumeSnapshot && !options.allowSensitiveContent)
        await assertShareable(records, this.signal, 'records.json')
      const alreadyExcluded = validateExcludedFiles(records, manifest.excludedFiles)
      const notebooks = await Promise.all(
        manifest.inventory
          .filter((entry) => entry.storageKey && notebookDocumentIdentity(entry.storageKey))
          .map(
            async (entry) =>
              (await readPackageJson(join(source, entry.path))) as NotebookRunDocument
          )
      )
      const inheritedExclusions = packageReproducibilityExclusions(records)
      diagnostic.phase('select-files')
      const selectable = selectablePackageFiles(records, notebooks).filter(
        (file) => !alreadyExcluded.has(file.storageKey)
      )
      const optionalKeys = new Set(
        [...selectable, ...inheritedExclusions].map((file) => file.storageKey)
      )
      const plannedFiles = markRequiredPackageFiles(
        records,
        selectable,
        manifest.inventory.filter(
          (entry) =>
            (!entry.storageKey || !optionalKeys.has(entry.storageKey)) &&
            !previousFilmKeys.has(entry.storageKey ?? '')
        )
      )
      const policyExcluded = await webPolicyExcludedFiles(
        plannedFiles,
        async (file) => {
          const entry = manifest.inventory.find((item) => item.storageKey === file.storageKey)
          if (!entry) throw new Error('Session package omits required content.')
          return join(source, entry.path)
        },
        forwardedWeb,
        this.signal
      )
      const selection = await this.chooseFiles(
        options,
        plannedFiles.filter((file) => !policyExcluded.has(file.storageKey)),
        {
          researchFilms: filmSummary,
          webOmissions: forwardedWeb?.omissions,
          pdfNotesAvailable: !!records.pdfNotes?.length,
          metadataBytes: manifest.inventory
            .filter((entry) => !entry.storageKey)
            .reduce((sum, entry) => sum + entry.sizeBytes, 0),
          retainedFiles: manifest.inventory
            .filter(
              (entry) =>
                entry.storageKey &&
                !optionalKeys.has(entry.storageKey) &&
                !previousFilmKeys.has(entry.storageKey)
            )
            .map((entry) => ({
              storageKey: entry.storageKey!,
              filename: entry.storageKey!,
              checksum: entry.checksum,
              sizeBytes: entry.sizeBytes
            }))
        },
        session.title
      )
      const excluded = new Set([...selection.excludedStorageKeys, ...policyExcluded])
      diagnostic.phase('forward-content')
      if (!selection.includePdfNotes && !options.consumeSnapshot) delete records.pdfNotes
      filterPackagePdfNotes(records, new Set([...excluded, ...alreadyExcluded]))
      const forwardedRecordsJson = JSON.stringify(records)
      const additional = selectable
        .filter((file) => excluded.has(file.storageKey))
        .map(({ storageKey, filename, sizeBytes }) => ({ storageKey, filename, sizeBytes }))
      if (excluded.size !== additional.length) throw new Error('Invalid package content selection.')
      for (const entry of manifest.inventory) {
        const copy = excludedNotebookInputCopy(records, additional, entry)
        if (copy) {
          additional.push(copy)
          excluded.add(copy.storageKey)
        }
      }
      const forwarded: SessionPackageManifest = {
        ...manifest,
        requiredFeatures: manifest.requiredFeatures?.filter(
          (feature) =>
            feature !== 'research-film' &&
            (feature !== 'web-search-operations-v1' ||
              !!records.webEvidence?.requiredCapabilities?.includes('web-search-operations-v1')) &&
            (feature !== 'web-restricted-result-v1' ||
              !!records.webEvidence?.requiredCapabilities?.includes('web-restricted-result-v1')) &&
            (feature !== 'web-evidence-v2' ||
              !!records.webEvidence?.requiredCapabilities?.includes('web-result-v2')) &&
            (feature !== 'log-evidence' || !!records.logEvidence) &&
            (feature !== 'compute-log-evidence' || hasComputeLogEvidence(records.logEvidence))
        ),
        inventory: manifest.inventory
          .filter(
            (entry) =>
              entry.path !== PACKAGE_RO_CRATE_METADATA &&
              !previousFilmKeys.has(entry.storageKey ?? '') &&
              (!entry.storageKey || !excluded.has(entry.storageKey))
          )
          .map((entry) =>
            entry.path === 'records.json'
              ? {
                  ...entry,
                  sizeBytes: Buffer.byteLength(forwardedRecordsJson),
                  checksum: sha256(forwardedRecordsJson)
                }
              : entry.path === 'session.json' && forwardedSessionJson
                ? {
                    ...entry,
                    sizeBytes: Buffer.byteLength(forwardedSessionJson),
                    checksum: sha256(forwardedSessionJson)
                  }
                : entry
          ),
        excludedFiles: [...manifest.excludedFiles, ...additional]
      }
      assertNoExcludedContentCopies(records, forwarded.excludedFiles, forwarded.inventory)
      // Fork transfers this snapshot into its publication journal with rename. Keep both
      // sides on the data volume, which may differ from the operating system temp volume.
      const staging = await mkdtemp(
        join(
          options.consumeSnapshot ? this.options.storageRoot : tmpdir(),
          'open-science-package-forward-'
        )
      )
      return withPackageCleanup(
        async () => {
          const uniqueForwardedBytes = [
            ...new Map(forwarded.inventory.map((entry) => [entry.path, entry.sizeBytes])).values()
          ].reduce((sum, size) => sum + size, 0)
          await assertPackageCapacity(staging, uniqueForwardedBytes)
          await mkdir(join(staging, 'objects'))
          const copiedPaths = new Set<string>()
          for (const entry of forwarded.inventory) {
            this.signal.throwIfAborted()
            if (copiedPaths.has(entry.path)) continue
            copiedPaths.add(entry.path)
            if (entry.path === 'records.json') {
              await writeFile(join(staging, entry.path), forwardedRecordsJson)
              continue
            }
            if (entry.path === 'session.json' && forwardedSessionJson) {
              await writeFile(join(staging, entry.path), forwardedSessionJson)
              continue
            }
            if (!options.consumeSnapshot)
              await assertWebShareableFile(join(source, entry.path), forwardedWeb, this.signal)
            if (!options.consumeSnapshot && !options.allowSensitiveContent)
              await assertShareableFile(
                join(source, entry.path),
                this.signal,
                entry.storageKey ?? entry.path,
                entry.storageKey,
                entry.storageKey
                  ? {
                      storageKey: entry.storageKey,
                      root: source,
                      relativePath: entry.path,
                      checksum: entry.checksum
                    }
                  : undefined
              )
            await copyFileWithinBudget(
              join(source, entry.path),
              join(staging, entry.path),
              entry.sizeBytes,
              this.signal,
              (completedBytes) =>
                options.onProgress?.({
                  phase: 'copying',
                  completedBytes,
                  totalBytes: entry.sizeBytes,
                  currentFile: entry.storageKey ?? entry.path
                })
            )
          }
          if (selection.includeResearchFilms || options.consumeSnapshot)
            await appendFilms(staging, records, forwarded, forwardedFilms, forwardedWeb)
          await writePackageRoCrateMetadata(staging, forwarded, records, this.signal)
          await writeFile(join(staging, 'manifest.json'), JSON.stringify(forwarded))
          options.onProgress?.({ phase: 'validating' })
          diagnostic.phase('validate-package')
          await validatePackageDirectory(staging, this.signal)
          await validatePackageRecords(staging, forwarded, records, this.signal)
          diagnostic.phase('publish-snapshot')
          if (options.consumeSnapshot) await options.consumeSnapshot(staging)
          else {
            options.onProgress?.({ phase: 'compressing' })
            await publishUserFile(path, (temporary) =>
              writePackageArchive(staging, temporary, this.signal)
            )
          }
          return preview(forwarded, forwardedSession, records.webEvidence?.omissions)
        },
        () => rm(staging, { recursive: true, force: true })
      )
    }
    const webProjection = await this.prepareWebProjection(
      session,
      options,
      filmOrigin?.webEvidence
        ? (mapPackageReferences(
            filmOrigin.webEvidence,
            filmOrigin.identities
          ) as PackageRecords['webEvidence'])
        : undefined
    )
    diagnostic.phase('read-notebooks')
    const assertSettled = (): void => {
      assertSettledHistory(session)
      if (this.options.isSessionActive?.(request.projectId, request.sessionId))
        throw new Error('Wait for the Session to finish before exporting it.')
    }
    assertSettled()
    const client = await this.options.getClient()
    const project = await client.project.findUniqueOrThrow({ where: { id: request.projectId } })
    const readNotebookKeys = async (): Promise<string[]> => {
      const keys = await notebookStorageKeys(this.options.storageRoot, request)
      // Published forks own this recovery marker. It is not Notebook evidence and must
      // never replace the fresh destination's marker on refork or export/import.
      const ownerKey = `notebooks/${request.projectId}/${request.sessionId}/.session-package-owner`
      return session.forkOrigin || session.packageOrigin
        ? keys.filter((key) => key !== ownerKey)
        : keys
    }
    const notebookKeys = await readNotebookKeys()
    const notebooks = await readPackageNotebooks(this.options.storageRoot, notebookKeys)
    const portableNotebooks = new Map<string, NotebookRunDocument>()
    let notebookIndex = 0
    for (const key of notebookKeys) {
      if (!notebookDocumentIdentity(key)) continue
      const document = notebooks[notebookIndex++]
      const stored = await readPackageJson(resolveStorageKey(this.options.storageRoot, key))
      if ((stored as { version?: number }).version === 2) portableNotebooks.set(key, document)
    }
    diagnostic.phase('collect-records')
    const bookmarkTargets = options.consumeSnapshot
      ? await readSessionBookmarkTargets(client, request)
      : []
    const bookmarkLiteratureIds = bookmarkTargets.flatMap(({ source }) =>
      source.kind === 'literature-attachment-version' ? [source.versionId] : []
    )
    const bookmarkVersionIds = bookmarkTargets.flatMap(({ source }) =>
      'versionId' in source && source.versionId && source.kind !== 'literature-attachment-version'
        ? [source.versionId]
        : []
    )
    const literatureIds = sessionLiteratureReferences(session).versionIds
    const imageTasks = await readStoredImageTasks(this.options.storageRoot, request)
    if (imageTasks.some(imageTaskIsActive))
      throw new Error('Wait for image tasks to finish before exporting this Session.')
    const versionIds = [
      ...new Set([
        ...sessionFileVersionIds(session).filter((id) => !literatureIds.has(id)),
        ...bookmarkVersionIds,
        ...imageTasks.map((task) => task.edit.source.sourceVersionId),
        ...notebooks.flatMap((document) =>
          document.runs.flatMap((run) =>
            (run.inputFiles ?? []).map((input) => input.inputFileVersionId)
          )
        )
      ])
    ]
    const records = await captureNativeRecords(client, request, versionIds)
    if (imageTasks.length) records.imageTasks = imageTasks
    const retainedOrigin =
      session.forkOrigin || filmOrigin?.nativeLogOrigin ? filmOrigin : undefined
    if (retainedOrigin?.literature)
      records.literature = mapPackageReferences(
        retainedOrigin.literature,
        retainedOrigin.identities
      ) as NonNullable<PackageRecords['literature']>
    const inheritedPdfNotes = namespacePackagePdfNotes(
      mapPackageReferences(
        retainedOrigin?.pdfNotes ?? [],
        retainedOrigin?.identities ?? {}
      ) as PackagePdfNotes,
      request.sessionId
    )
    const literatureSources = await capturePackageLiterature(
      this.options.literatureSource,
      session,
      records,
      bookmarkLiteratureIds
    )
    const sourceKey = (key: string): string =>
      capturedFilms.files.get(key)?.sourceKey ?? literatureSources.get(key) ?? key
    diagnostic.phase('collect-history')
    const history = await this.captureHistory(session)
    records.history = history
    diagnostic.phase('collect-reproducibility')
    records.reproducibility = await capturePackageReproducibility(
      this.options.storageRoot,
      records,
      request,
      this.signal
    )
    const inheritedExclusions = [
      ...new Map(
        [
          ...packageReproducibilityExclusions(records),
          ...(retainedOrigin?.sourceManifest.excludedFiles.map((file) => ({
            ...file,
            storageKey: remapStorageKey(file.storageKey, retainedOrigin.identities)
          })) ?? [])
        ].map((file) => [file.storageKey, file])
      ).values()
    ]
    const selectable = selectablePackageFiles(records, notebooks)
    diagnostic.phase('collect-execution-evidence')
    const logEvidence = await collectPackageLogEvidence(
      this.options.storageRoot,
      records,
      notebooks,
      this.signal,
      options.consumeSnapshot ? undefined : request
    )
    if (logEvidence) {
      records.logEvidence = logEvidence
    }
    const executionKeys = await executionEvidenceKeys(
      this.options.storageRoot,
      records,
      notebooks,
      this.signal
    )
    const sharedSession = encodeSessionDataPaths(
      withoutPrivateAuthority(webProjection ? projectWebSessionCopies(webProjection) : session),
      this.options.storageRoot
    )
    const optionalKeys = new Set(
      [...selectable, ...inheritedExclusions].map((file) => file.storageKey)
    )
    const retainedFiles: PackageSelectionSummary['retainedFiles'] = []
    const measuredContent = new Map<string, { checksum: string; sizeBytes: number }>()
    const immutableVersions = new Set(
      [...records.tables.ArtifactVersion, ...records.tables.UploadVersion].flatMap((row) =>
        typeof row.contentStorageKey === 'string' &&
        (row.state === 'finalized' || row.state === 'ready')
          ? [row.contentStorageKey]
          : []
      )
    )
    const sourceObservations = new Map<
      string,
      { observation: FileObservation; integrity: { checksum: string; sizeBytes: number } }
    >()
    diagnostic.phase('measure-content')
    for (const key of new Set([
      ...nativeStorageKeys(records),
      ...notebookKeys,
      ...executionKeys,
      ...packageReproducibilityKeys(records)
    ])) {
      if (optionalKeys.has(key)) continue
      this.signal.throwIfAborted()
      await assertPackageSourcePath(this.options.storageRoot, sourceKey(key))
      const portableNotebook = portableNotebooks.get(key)
      if (portableNotebook) {
        const contents = JSON.stringify(
          encodeRunDocumentDataPaths(portableNotebook, this.options.storageRoot)
        )
        retainedFiles.push({
          storageKey: key,
          filename: key,
          sizeBytes: Buffer.byteLength(contents),
          checksum: sha256(contents)
        })
        continue
      }
      const original = resolveStorageKey(this.options.storageRoot, sourceKey(key))
      const observation = observeFile(await lstat(original, { bigint: true }))
      // Shared evidence paths can name one inode, with the same observation and digest.
      const identity = observation.inode !== '0' ? JSON.stringify(observation) : key
      const integrity =
        measuredContent.get(identity) ??
        (await digestFileWithinBudget(original, observation.sizeBytes, this.signal))
      if (!sameFileObservation(observation, observeFile(await lstat(original, { bigint: true }))))
        throw new Error('The Session changed during export. Try again.')
      measuredContent.set(identity, integrity)
      if (immutableVersions.has(key) && observation.inode !== '0')
        sourceObservations.set(key, { observation, integrity })
      retainedFiles.push({ storageKey: key, filename: key, ...integrity })
    }
    const sessionJson = JSON.stringify({ version: 2, session: sharedSession })
    let publicRecords = projectWebRecords(records, webProjection)
    let recordsJson = JSON.stringify(publicRecords)
    const fixedMetadataBytes = Buffer.byteLength(sessionJson) + Buffer.byteLength(PACKAGE_README)
    diagnostic.phase('select-files')
    const plannedFiles = markRequiredPackageFiles(records, selectable, [
      ...retainedFiles,
      ...[sessionJson, recordsJson, PACKAGE_README].map((content) => ({
        sizeBytes: Buffer.byteLength(content),
        checksum: sha256(content)
      }))
    ])
    const policyExcluded = await webPolicyExcludedFiles(
      plannedFiles,
      async (file) => {
        await assertPackageSourcePath(this.options.storageRoot, sourceKey(file.storageKey))
        return resolveStorageKey(this.options.storageRoot, sourceKey(file.storageKey))
      },
      webProjection,
      this.signal
    )
    recordsJson = JSON.stringify(publicRecords)
    let metadataBytes = fixedMetadataBytes + Buffer.byteLength(recordsJson)
    const selection = await this.chooseFiles(
      options,
      plannedFiles.filter((file) => !policyExcluded.has(file.storageKey)),
      {
        retainedFiles,
        metadataBytes,
        webOmissions: webProjection?.omissions,
        researchFilms: filmSummary,
        pdfNotesAvailable: selectable.some((file) => /\.pdf$/i.test(file.filename))
      },
      session.title
    )
    const excludedKeys = new Set([
      ...selection.excludedStorageKeys,
      ...policyExcluded,
      ...inheritedExclusions.map((file) => file.storageKey)
    ])
    diagnostic.phase('prepare-content')
    if (selection.includePdfNotes) {
      records.pdfNotes = await capturePackagePdfNotes(client, records, excludedKeys)
      retainInheritedPdfNotes(records, inheritedPdfNotes, excludedKeys)
      publicRecords = projectWebRecords(records, webProjection)
      recordsJson = JSON.stringify(publicRecords)
      metadataBytes = fixedMetadataBytes + Buffer.byteLength(recordsJson)
    }
    const excludedFiles = [
      ...new Map(
        [...selectable, ...inheritedExclusions].map((file) => [file.storageKey, file])
      ).values()
    ]
      .filter((file) => excludedKeys.has(file.storageKey))
      .map(({ storageKey, filename, sizeBytes }) => ({ storageKey, filename, sizeBytes }))
    if (excludedKeys.size !== excludedFiles.length)
      throw new Error('Invalid package content selection.')
    validateExcludedFiles(records, excludedFiles)
    if (!options.consumeSnapshot && !options.allowSensitiveContent)
      await assertShareable(sharedSession, this.signal, 'session.json')
    const directory = await mkdtemp(
      join(
        options.consumeSnapshot ? this.options.storageRoot : tmpdir(),
        'open-science-package-export-'
      )
    )
    let notebookStaging: string | undefined
    return withPackageCleanup(
      async () => {
        // Keep the portable package format independent of the local record layout.
        const notebookSources = new Map<string, string>()
        for (const [key, document] of portableNotebooks) {
          notebookStaging ??= await mkdtemp(join(tmpdir(), 'open-science-notebook-export-'))
          const snapshot = join(notebookStaging, `${notebookSources.size}.json`)
          const contents = JSON.stringify(
            encodeRunDocumentDataPaths(document, this.options.storageRoot)
          )
          const bytes = Buffer.byteLength(contents)
          if (bytes > PACKAGE_MAX_FILE_BYTES)
            throw new Error('Invalid or oversized package source file.')
          await assertPackageCapacity(notebookStaging, bytes)
          await writeFile(snapshot, contents)
          notebookSources.set(key, snapshot)
        }
        const sourcePath = (key: string): string =>
          notebookSources.get(key) ?? resolveStorageKey(this.options.storageRoot, sourceKey(key))
        diagnostic.phase('copy-content')
        if (!options.consumeSnapshot && !options.allowSensitiveContent)
          await assertShareable(publicRecords, this.signal, 'records.json')
        const totalBytes = metadataBytes
        const storageKeys = [
          ...new Set([
            ...nativeStorageKeys(records),
            ...notebookKeys,
            ...executionKeys,
            ...packageReproducibilityKeys(records)
          ])
        ].filter((key) => !excludedKeys.has(key))
        const sizes = new Map<string, number>()
        // Hash before copying so equal bytes can share one object without a temporary second copy.
        const contentIntegrity = new Map<string, { sizeBytes: number; checksum: string }>()
        const contentOwners = new Map<string, string>()
        let physicalContentBytes = 0
        for (const key of storageKeys) {
          await assertPackageSourcePath(this.options.storageRoot, sourceKey(key))
          const original = sourcePath(key)
          const observation = observeFile(await lstat(original, { bigint: true }))
          const observed = sourceObservations.get(key)
          if (observed && !sameFileObservation(observed.observation, observation))
            throw new Error('The Session changed during export. Try again.')
          const size = observation.sizeBytes
          if (isNotebookInputCopy(key) && excludedFiles.some((file) => file.sizeBytes === size)) {
            const digest = await digestFileWithinBudget(original, size, this.signal)
            const omittedInput = excludedNotebookInputCopy(records, excludedFiles, {
              ...digest,
              storageKey: key
            })
            if (omittedInput) {
              excludedFiles.push(omittedInput)
              continue
            }
          }
          sizes.set(key, size)
          const integrity =
            observed?.integrity ?? (await digestFileWithinBudget(original, size, this.signal))
          if (
            integrity.sizeBytes !== size ||
            (!observed &&
              !sameFileObservation(
                observation,
                observeFile(await lstat(original, { bigint: true }))
              ))
          )
            throw new Error('The Session changed during export. Try again.')
          if (immutableVersions.has(key) && observation.inode !== '0')
            sourceObservations.set(key, { observation, integrity })
          contentIntegrity.set(key, integrity)
          const contentIdentity = `${integrity.sizeBytes}:${integrity.checksum}`
          if (!contentOwners.has(contentIdentity)) {
            contentOwners.set(contentIdentity, key)
            physicalContentBytes += integrity.sizeBytes
          }
        }
        const selectedBytes = [...sizes.values()].reduce((sum, size) => sum + size, 0)
        if (physicalContentBytes + totalBytes > PACKAGE_MAX_BYTES)
          throw new Error('Session package exceeds the export limit.')
        await assertPackageCapacity(directory, physicalContentBytes + metadataBytes)
        await writeFile(join(directory, 'session.json'), sessionJson)
        await writeFile(join(directory, 'records.json'), recordsJson)
        await writeFile(join(directory, 'README.md'), PACKAGE_README)
        const inventory = await Promise.all([
          packageEntry(directory, 'session.json', 'session'),
          packageEntry(directory, 'records.json', 'records'),
          packageEntry(directory, 'README.md', 'readme')
        ])
        await mkdir(join(directory, 'objects'))
        let completedBytes = 0
        let completedFiles = 0
        let deduplicated = false
        const copiedContent = new Map<
          string,
          { objectPath: string; integrity: { sizeBytes: number; checksum: string } }
        >()
        for (const storageKey of sizes.keys()) {
          assertPortablePackageStorageKey(storageKey)
          await assertPackageSourcePath(this.options.storageRoot, sourceKey(storageKey))
          const original = sourcePath(storageKey)
          const metadata = await lstat(original, { bigint: true })
          const observation = observeFile(metadata)
          const observed = sourceObservations.get(storageKey)
          const size = observation.sizeBytes
          if (observed && !sameFileObservation(observed.observation, observation))
            throw new Error('The Session changed during export. Try again.')
          if (!metadata.isFile() || size > PACKAGE_MAX_FILE_BYTES)
            throw new Error('Invalid or oversized package source file.')
          if (inventory.length >= 10000)
            throw new Error('Session package exceeds the export limit.')
          const measured = contentIntegrity.get(storageKey)
          if (!measured || measured.sizeBytes !== size)
            throw new Error('The Session changed during export. Try again.')
          const contentIdentity = `${measured.sizeBytes}:${measured.checksum}`
          const existing = copiedContent.get(contentIdentity)
          const objectPath = `objects/${sha256(storageKey)}`
          const currentFile =
            selectable.find((file) => file.storageKey === storageKey)?.filename ?? storageKey
          let copied: { sizeBytes: number; checksum: string }
          let objectPathForEntry = objectPath
          if (existing) {
            const current =
              observed?.integrity ?? (await digestFileWithinBudget(original, size, this.signal))
            if (current.checksum !== measured.checksum || current.sizeBytes !== size)
              throw new Error('The Session changed during export. Try again.')
            copied = existing.integrity
            objectPathForEntry = existing.objectPath
            deduplicated = true
            completedBytes += copied.sizeBytes
            options.onProgress?.({
              phase: 'copying',
              completedBytes,
              totalBytes: selectedBytes,
              completedFiles: completedFiles + 1,
              totalFiles: sizes.size,
              currentFile
            })
          } else {
            copied = await copyFileWithinBudget(
              original,
              join(directory, objectPath),
              size,
              this.signal,
              (bytes) =>
                options.onProgress?.({
                  phase: 'copying',
                  completedBytes: completedBytes + bytes,
                  totalBytes: selectedBytes,
                  completedFiles,
                  totalFiles: sizes.size,
                  currentFile
                })
            )
            if (copied.sizeBytes !== size || copied.checksum !== measured.checksum)
              throw new Error('The Session changed during export. Try again.')
            copiedContent.set(contentIdentity, { objectPath, integrity: copied })
            completedBytes += copied.sizeBytes
          }
          completedFiles += 1
          assertNoExcludedContentCopies(records, excludedFiles, [copied])
          if (!existing && !options.consumeSnapshot) {
            await assertWebShareableFile(
              join(directory, objectPathForEntry),
              webProjection,
              this.signal
            )
            if (!options.allowSensitiveContent)
              await assertShareableFile(
                join(directory, objectPathForEntry),
                this.signal,
                storageKey,
                sourceKey(storageKey),
                {
                  storageKey: sourceKey(storageKey),
                  root: this.options.storageRoot,
                  relativePath: sourceKey(storageKey),
                  checksum: copied.checksum
                }
              )
          }
          inventory.push({
            path: objectPathForEntry,
            kind: notebookKeys.includes(storageKey) ? 'notebook' : 'file',
            ...copied,
            storageKey
          })
        }
        const requiredFeatures = [
          ...(publicRecords.logEvidence ? (['log-evidence'] as const) : []),
          ...(hasComputeLogEvidence(publicRecords.logEvidence)
            ? (['compute-log-evidence'] as const)
            : []),
          ...(publicRecords.literature ? (['literature'] as const) : []),
          ...(publicRecords.webEvidence?.requiredCapabilities?.includes('web-result-v2')
            ? (['web-evidence-v2'] as const)
            : []),
          ...(publicRecords.webEvidence?.requiredCapabilities?.includes('web-restricted-result-v1')
            ? (['web-restricted-result-v1'] as const)
            : []),
          ...(publicRecords.webEvidence?.requiredCapabilities?.includes('web-search-operations-v1')
            ? (['web-search-operations-v1'] as const)
            : []),
          ...(deduplicated ? (['content-dedupe'] as const) : [])
        ]
        const manifest: SessionPackageManifest = {
          format: 'open-science-session',
          ...(requiredFeatures.length ? { requiredFeatures } : {}),
          schemaVersion: 1,
          createdAt:
            options.consumeSnapshot && records.logEvidence ? session.updatedAt : Date.now(),
          source: { ...request, projectName: project.name, title: session.title },
          inventory,
          excludedFiles,
          omissions: [
            ...(records.reproducibility?.versions.some((version) =>
              version.environmentLocks.some((lock) => lock.serialized === undefined)
            )
              ? [
                  {
                    kind: 'missing' as const,
                    description:
                      'Some referenced environment lock files are unavailable; their checksums are retained.'
                  }
                ]
              : []),
            {
              kind: 'excluded',
              description:
                'Account credentials, permission grants and provider continuation identities are excluded.'
            },
            ...(history.computeJobs.some((job) => job.protectedContentUnavailable)
              ? [
                  {
                    kind: 'missing' as const,
                    description:
                      'Some protected Compute evidence could not be decrypted on this computer.'
                  }
                ]
              : []),
            ...(history.computeJobs.some((job) => job.leftOnRemote)
              ? [
                  {
                    kind: 'external' as const,
                    description: 'Files left on remote Compute hosts are not included.'
                  }
                ]
              : [])
          ]
        }
        if (selection.includeResearchFilms || options.consumeSnapshot)
          await appendFilms(directory, publicRecords, manifest, capturedFilms, webProjection)
        if (publicRecords.researchFilms) records.researchFilms = publicRecords.researchFilms
        if (publicRecords.operationReplayFilms)
          records.operationReplayFilms = publicRecords.operationReplayFilms
        await writePackageRoCrateMetadata(directory, manifest, publicRecords, this.signal)
        await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
        options.onProgress?.({ phase: 'validating' })
        diagnostic.phase('validate-package')
        await validatePackageRecords(directory, manifest, publicRecords, this.signal)
        assertSettled()
        if (JSON.stringify(await readNotebookKeys()) !== JSON.stringify(notebookKeys))
          throw new Error('The Session changed during export. Try again.')
        if (
          !isDeepStrictEqual(
            await readPackageNotebooks(this.options.storageRoot, notebookKeys),
            notebooks
          )
        )
          throw new Error('The Session changed during export. Try again.')
        for (const entry of inventory) {
          if (!entry.storageKey) continue
          await assertPackageSourcePath(this.options.storageRoot, sourceKey(entry.storageKey))
          const original = sourcePath(entry.storageKey)
          const observed = sourceObservations.get(entry.storageKey)
          if (
            observed &&
            !sameFileObservation(
              observed.observation,
              observeFile(await lstat(original, { bigint: true }))
            )
          )
            throw new Error('The Session changed during export. Try again.')
          const currentFile =
            observed?.integrity ??
            (await digestFileWithinBudget(original, entry.sizeBytes, this.signal))
          if (currentFile.sizeBytes !== entry.sizeBytes || currentFile.checksum !== entry.checksum)
            throw new Error('The Session changed during export. Try again.')
        }
        const current = await loadSessionMutationAuthority(
          sessions,
          request.projectId,
          request.sessionId
        )
        const currentRecords = await captureNativeRecords(client, request, versionIds)
        const currentImageTasks = await readStoredImageTasks(this.options.storageRoot, request)
        if (currentImageTasks.length) currentRecords.imageTasks = currentImageTasks
        if (records.logEvidence)
          currentRecords.logEvidence = await collectPackageLogEvidence(
            this.options.storageRoot,
            records,
            notebooks,
            this.signal
          )
        if (records.researchFilms) currentRecords.researchFilms = records.researchFilms
        if (records.operationReplayFilms)
          currentRecords.operationReplayFilms = records.operationReplayFilms
        if (retainedOrigin?.literature)
          currentRecords.literature = mapPackageReferences(
            retainedOrigin.literature,
            retainedOrigin.identities
          ) as NonNullable<PackageRecords['literature']>
        const currentLiteratureSources = await capturePackageLiterature(
          this.options.literatureSource,
          session,
          currentRecords,
          bookmarkLiteratureIds
        )
        if (!isDeepStrictEqual(currentLiteratureSources, literatureSources))
          throw new Error('The Session changed during export. Try again.')
        currentRecords.history = await this.captureHistory(session)
        currentRecords.reproducibility = await capturePackageReproducibility(
          this.options.storageRoot,
          currentRecords,
          request,
          this.signal
        )
        if (selection.includePdfNotes) {
          currentRecords.pdfNotes = await capturePackagePdfNotes(
            client,
            currentRecords,
            excludedKeys
          )
          retainInheritedPdfNotes(currentRecords, inheritedPdfNotes, excludedKeys)
        }
        if (
          current.status !== 'found' ||
          !isDeepStrictEqual(
            exportRelevantSession(current.session),
            exportRelevantSession(session)
          ) ||
          !isDeepStrictEqual(currentRecords, records)
        )
          throw new Error('The Session changed during export. Try again.')
        diagnostic.phase('publish-snapshot')
        if (options.consumeSnapshot) await options.consumeSnapshot(directory)
        else {
          options.onProgress?.({ phase: 'compressing' })
          await publishUserFile(path, (temporaryPath) =>
            writePackageArchive(directory, temporaryPath, this.signal)
          )
        }
        return preview(manifest, sharedSession, publicRecords.webEvidence?.omissions)
      },
      async () => {
        await rm(directory, { recursive: true, force: true })
        if (notebookStaging) await rm(notebookStaging, { recursive: true, force: true })
      }
    )
  }

  private async prepareWebProjection(
    session: PersistedChatSession,
    options: PackageSnapshotOptions,
    existingEvidence?: PackageRecords['webEvidence']
  ): Promise<WebEvidenceProjection | undefined> {
    if (options.consumeSnapshot) return undefined
    const projection = await prepareWebEvidence(session, {
      resolvePolicy: this.options.webEvidence?.resolvePolicy,
      existingEvidence,
      loadSnapshot: this.options.webEvidence?.loadSnapshot
        ? (id, activity) => this.options.webEvidence!.loadSnapshot!(session, id, activity)
        : undefined
    })
    return projection.plan.packets.size || projection.omissions.length || existingEvidence
      ? projection
      : undefined
  }

  private async captureHistory(session: PersistedChatSession): Promise<PackageHistory> {
    const current = await capturePackageHistory(this.configRoot, this.options.getClient, {
      projectId: session.projectId,
      sessionId: session.id
    })
    if (!session.packageOrigin && !session.forkOrigin) return current
    const origin = await this.readOrigin({ projectId: session.projectId, sessionId: session.id })
    const checksums = Object.fromEntries(
      origin.files.map((f) => [f.sourceChecksum, f.localChecksum])
    )
    if (origin.nativeLogOrigin)
      Object.assign(
        checksums,
        await inheritedComputeChecksums(
          this.options.storageRoot,
          'execution-file-evidence/' + session.projectId + '/' + session.id,
          origin.history,
          origin.identities,
          (session.packageOrigin ?? session.forkOrigin)!.manifestChecksum
        )
      )
    const inherited = mapPackageReferences(origin.history, origin.identities, '', checksums) as
      PackageHistory | undefined
    return {
      taskRuns: [...(inherited?.taskRuns ?? []), ...current.taskRuns],
      computeJobs: [...(inherited?.computeJobs ?? []), ...current.computeJobs]
    }
  }

  fork(
    request: SessionPackageRequest,
    signal?: AbortSignal,
    onProgress?: (progress: PackageProgress) => void
  ): Promise<SessionPackageRequest> {
    const safe = sessionPackageRequestSchema.parse(request)
    return this.serialize(async () => {
      await this.assertImportProject(safe.projectId)
      return this.withExportReservation(safe, async () => {
        const source = await new SessionRepository(this.configRoot).loadSession(
          safe.projectId,
          safe.sessionId
        )
        if (!source) throw new Error('Session not found or unreadable.')
        if (
          source.runtimeContext?.networkApprovals?.some(({ state }) => state === 'pending') ||
          source.runtimeContext?.permission?.state === 'pending' ||
          source.runtimeContext?.plan?.approval === 'pending'
        )
          throw new Error('Wait for pending approvals before forking this Session.')
        let result: SessionPackageRequest | undefined
        await this.exportNow(safe, '', {
          onProgress,
          consumeSnapshot: async (directory) => {
            result = await this.importNow(
              directory,
              onProgress,
              undefined,
              { projectId: safe.projectId },
              source
            )
          }
        })
        if (!result) throw new Error('Fork did not publish a Session.')
        return result
      })
    }, signal)
  }

  inspect(
    path: string,
    signal?: AbortSignal,
    onProgress?: (progress: PackageProgress) => void
  ): Promise<SessionPackagePreview> {
    return this.serialize(() => this.inspectNow(path, onProgress), signal)
  }

  private async inspectNow(
    path: string,
    onProgress?: (progress: PackageProgress) => void
  ): Promise<SessionPackagePreview> {
    const directory = await mkdtemp(join(tmpdir(), 'open-science-package-inspect-'))
    return withPackageCleanup(
      () =>
        (this.options.inspectPackage ?? inspectSessionPackage)(
          path,
          directory,
          this.signal,
          undefined,
          onProgress
        ),
      () => rm(directory, { recursive: true, force: true })
    )
  }

  importFrom(
    path: string,
    signal?: AbortSignal,
    onProgress?: (progress: PackageProgress) => void,
    confirm?: (preview: SessionPackagePreview, signal: AbortSignal) => Promise<void>,
    target: SessionPackageImportRequest = {}
  ): Promise<{ projectId: string; sessionId: string }> {
    const safeTarget = sessionPackageImportRequestSchema.parse(target)
    return this.serialize(() => this.importNow(path, onProgress, confirm, safeTarget), signal)
  }

  private async importNow(
    path: string,
    onProgress: ((progress: PackageProgress) => void) | undefined,
    confirm: ((preview: SessionPackagePreview, signal: AbortSignal) => Promise<void>) | undefined,
    target: SessionPackageImportRequest,
    forkSource?: PersistedChatSession
  ): Promise<{ projectId: string; sessionId: string }> {
    const retries = join(this.configRoot, 'session-package-log-retries')
    const intentPath = async (): Promise<string> => {
      const digest = await fileChecksum(
        forkSource ? join(path, 'manifest.json') : path,
        this.signal
      )
      return join(
        retries,
        sha256(
          JSON.stringify([
            digest,
            target.projectId ?? null,
            target.projectName ?? null,
            forkSource?.id ?? null
          ])
        ) + '.json'
      )
    }
    // Most imports have no interrupted operation. Preserve the old inspector-first path
    // and avoid an extra file pass unless an allocation must be saved or recovered.
    const pending = await readdir(retries).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    let retryPath: string | undefined
    let previous: LogIdentityPlan | undefined
    if (pending.length) {
      retryPath = await intentPath()
      const saved = await readPackageJson(retryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
      if (saved) previous = logIdentityPlanSchema.parse(saved)
    }
    const operationId = previous?.operationId ?? randomUUID()
    const projectId = target.projectId ?? 'import-' + operationId
    if (previous && previous.projectId !== projectId)
      throw new Error('Invalid log import retry scope.')
    const lease: { path?: string } = {}
    const claim = (key: string): void => {
      if (activeLogImports.has(key)) throw new Error('This evidence import is already in progress.')
      activeLogImports.add(key)
      lease.path = key
    }
    try {
      if (previous && retryPath) {
        claim(retryPath)
        await this.recoverNow(previous.operationId)
        const client = await this.options.getClient()
        const witness = await client.fileOriginSession.findUnique({
          where: { projectId_sessionId: { projectId, sessionId: previous.sessionId } }
        })
        if (witness) {
          await rm(retryPath, { force: true })
          return { projectId, sessionId: previous.sessionId }
        }
      }
      const allocate = async (
        manifestChecksum: string
      ): Promise<{ path: string; operationId: string; previous?: LogIdentityPlan }> => {
        if (previous && previous.manifestChecksum !== manifestChecksum)
          throw new Error('Source manifest changed during import retry.')
        await mkdir(retries, { recursive: true, mode: 0o700 })
        // A fork snapshot is transferred into the operation stage before allocation.
        const key =
          retryPath ??
          (forkSource
            ? join(
                retries,
                sha256(
                  JSON.stringify([
                    manifestChecksum,
                    target.projectId ?? null,
                    target.projectName ?? null,
                    forkSource.id
                  ])
                ) + '.json'
              )
            : await intentPath())
        if (!lease.path) claim(key)
        return { path: key, operationId, previous }
      }
      return await withWorkingFileEvidenceRead(this.options.storageRoot, projectId, () =>
        this.importSnapshot(
          path,
          onProgress,
          confirm,
          target,
          {
            operationId,
            projectId,
            sessionId: previous?.sessionId ?? (forkSource ? randomUUID() : 'import-' + randomUUID())
          },
          allocate,
          forkSource
        )
      )
    } finally {
      if (lease.path) activeLogImports.delete(lease.path)
    }
  }

  private async importSnapshot(
    path: string,
    onProgress: ((progress: PackageProgress) => void) | undefined,
    confirm: ((preview: SessionPackagePreview, signal: AbortSignal) => Promise<void>) | undefined,
    target: SessionPackageImportRequest,
    {
      operationId,
      projectId,
      sessionId
    }: { operationId: string; projectId: string; sessionId: string },
    allocate: (
      checksum: string
    ) => Promise<{ path: string; operationId: string; previous?: LogIdentityPlan }>,
    forkSource?: PersistedChatSession
  ): Promise<{ projectId: string; sessionId: string }> {
    if (target.projectId) await this.assertImportProject(target.projectId)
    // Only read-only imports use the import identity convention consumed by the lazy catalog.
    const operationRoot = join(this.options.storageRoot, 'session-package-imports', operationId)
    const configOperationRoot = join(this.configRoot, 'session-package-imports', operationId)
    const sourceRoot = join(operationRoot, 'source')
    const destinationRoot = join(operationRoot, 'destination')
    await mkdir(join(this.configRoot, 'session-package-imports'), { recursive: true, mode: 0o700 })
    await mkdir(configOperationRoot, { mode: 0o700 })
    if (operationRoot !== configOperationRoot) {
      try {
        await mkdir(join(this.options.storageRoot, 'session-package-imports'), {
          recursive: true,
          mode: 0o700
        })
        await mkdir(operationRoot, { mode: 0o700 })
      } catch (error) {
        // Only the config stage has been claimed. Do not remove a data path whose exclusive
        // creation failed. Keep the admission failure and make config cleanup retryable.
        return withPackageCleanup(
          async () => {
            throw error
          },
          () => rm(configOperationRoot, { recursive: true, force: true })
        )
      }
    }
    const cleanupStaging = async (): Promise<void> => {
      await rm(operationRoot, { recursive: true, force: true })
      if (configOperationRoot !== operationRoot)
        await rm(configOperationRoot, { recursive: true, force: true })
      await defaultFileDurability.syncDirectory(join(this.configRoot, 'session-package-imports'))
    }
    let published: boolean | undefined = false
    let preparedWebFork: PersistedChatSession | undefined
    let journal: ImportJournal | undefined
    let retryPlan: Awaited<ReturnType<typeof allocate>> | undefined
    const recoveryError = (cause: unknown): PackageImportRecoveryRequiredError =>
      new PackageImportRecoveryRequiredError({ projectId, sessionId }, resume, cause)
    const resume = (signal?: AbortSignal): Promise<SessionPackageRequest | undefined> =>
      this.serialize(async () => {
        try {
          if (published === undefined) {
            const client = await this.options.getClient()
            published = Boolean(
              await client.fileOriginSession.findUnique({
                where: { projectId_sessionId: { projectId, sessionId } }
              })
            )
          }
          if (published) {
            // A data-root reconnect may already have recovered and removed the journal. The
            // captured journal still identifies the same live authority, including deletion.
            await this.finishPublishedImport(configOperationRoot, operationId, journal)
          }
        } catch (error) {
          throw recoveryError(error)
        }
        return withPackageCleanup(
          async () => (published ? { projectId, sessionId } : undefined),
          async () => {
            if (!published && journal) await this.removeUnpublished(journal, operationId)
            await cleanupStaging()
          }
        )
      }, signal).catch((error: unknown) => {
        if (error instanceof PackageCleanupPendingError) throw error
        if (error instanceof PackageImportRecoveryRequiredError) throw error
        throw recoveryError(error)
      })
    try {
      await writeFile(join(operationRoot, '.session-package-owner'), operationId, { flag: 'wx' })
      if (forkSource) {
        await rename(path, sourceRoot)
        await validatePackageDirectory(sourceRoot, this.signal)
      } else {
        const inspected = await (this.options.inspectPackage ?? inspectSessionPackage)(
          path,
          sourceRoot,
          this.signal,
          undefined,
          onProgress
        )
        if (confirm) await this.waitForUser(() => confirm(inspected, this.signal))
      }
      this.signal.throwIfAborted()
      onProgress?.({ phase: 'importing' })
      // Keep the confirmation boundary small. Only after approval materialize the already
      // validated private files for remapping and the existing main-process publication owner.
      const manifest = sessionPackageManifestSchema.parse(
        await readPackageJson(join(sourceRoot, 'manifest.json'))
      )
      const sourceSession = await readSession(sourceRoot)
      this.assertIdentity(manifest, sourceSession)
      const records = parseNativeRecords(await readPackageJson(join(sourceRoot, 'records.json')))
      validateResearchFilms(records, manifest, sourceSession)
      validatePackageLiteratureSession(records, sourceSession)
      const manifestChecksum = await fileChecksum(join(sourceRoot, 'manifest.json'))
      if (records.logEvidence) retryPlan = await allocate(manifestChecksum)
      const native = await prepareNativeImport(
        sourceRoot,
        destinationRoot,
        manifest,
        records,
        projectId,
        sessionId,
        sourceSession,
        this.signal,
        onProgress,
        retryPlan
      )
      const bookmarkIdentities = { ...native.identities }
      let forkWebEvidence: PackageRecords['webEvidence']
      if (forkSource?.packageOrigin) {
        const origin = await this.readOrigin({
          projectId: forkSource.projectId,
          sessionId: forkSource.id
        })
        for (const [originalId, localId] of Object.entries(origin.identities)) {
          if (native.identities[originalId])
            bookmarkIdentities[localId] = native.identities[originalId]
        }
        forkWebEvidence = origin.webEvidence
          ? (mapPackageReferences(
              origin.webEvidence,
              origin.identities
            ) as PackageRecords['webEvidence'])
          : undefined
      }
      await installPackageReproducibility(
        destinationRoot,
        native.records,
        new Set(
          manifest.excludedFiles.map((file) => remapStorageKey(file.storageKey, native.identities))
        )
      )
      // Upstream files can belong to retained/deleted source Sessions. They are imported evidence
      // too, so the same read-only admission marker covers each destination source scope.
      for (const origin of native.records.tables.FileOriginSession) {
        await mkdir(
          join(
            destinationRoot,
            'artifacts',
            String(origin.projectId),
            String(origin.sessionId),
            '.session-package'
          ),
          { recursive: true }
        )
      }
      let mappedSession = withoutPrivateAuthority(
        mapPackageReferences(
          sourceSession,
          native.identities,
          '',
          native.checksums
        ) as PersistedChatSession
      )
      if (!forkSource) {
        const importedWeb = remapWebEvidence(
          sourceSession,
          mappedSession,
          records.webEvidence,
          native.identities
        )
        mappedSession = importedWeb.session
        native.records.webEvidence = importedWeb.webEvidence
      }
      let session: PersistedChatSession = {
        ...mappedSession,
        parentSessionId: undefined,
        id: sessionId,
        projectId,
        number: undefined,
        revision: undefined,
        cwd: '',
        status: 'idle',
        providerSessionId: undefined,
        providerContinuityToken: undefined,
        permissionProfile: 'ask',
        memoryEnabled: false,
        delegationPolicy: 'deny',
        autoReviewEnabled: false,
        enabledComputeHosts: [],
        selectedComputeHosts: [],
        specialistId: undefined,
        specialistBindingPending: undefined,
        runtimeContext: mappedSession.runtimeContext
          ? {
              ...mappedSession.runtimeContext,
              networkApprovals: undefined,
              sideChatRelays: undefined,
              // Local reading links are not part of a portable Session package.
              sessionContext: undefined,
              plan: mappedSession.runtimeContext.plan
                ? { ...mappedSession.runtimeContext.plan, delivery: undefined }
                : undefined
            }
          : undefined,
        activeRun: undefined,
        taskRunCommitId: undefined,
        resumeRecovery: undefined,
        pendingHistoryReplay: undefined,
        forkOrigin: undefined,
        packageOrigin: {
          importId: operationId,
          sourceProjectId: sourceSession.projectId,
          sourceSessionId: sourceSession.id,
          importedAt: Date.now(),
          manifestChecksum,
          excludedFiles: manifest.excludedFiles
        }
      }
      if (forkSource) {
        const client = await this.options.getClient()
        const siblings = await client.session.findMany({
          where: { projectId },
          select: { title: true }
        })
        session = createForkSession(
          session,
          forkSource,
          (await this.options.getDefaultPermissionProfile?.()) ?? DEFAULT_PERMISSION_PROFILE,
          nextForkTitle(
            forkSource.title,
            siblings.map((sibling) => sibling.title)
          )
        )
        session = preserveLocalForkWebEvidence(forkSource, session, bookmarkIdentities)
        if (forkWebEvidence) {
          const inheritedWeb = remapWebEvidence(
            forkSource,
            session,
            forkWebEvidence,
            bookmarkIdentities
          )
          session = inheritedWeb.session
          native.records.webEvidence = inheritedWeb.webEvidence
        }
        await this.options.onForkPrepared?.(forkSource, session)
        preparedWebFork = session
      }
      validatePackageLiteratureSession(native.records, session)
      const sessionStage = join(configOperationRoot, 'session-stage')
      const evidenceDirectory = join(
        destinationRoot,
        'artifacts',
        projectId,
        sessionId,
        forkSource ? '.session-fork' : '.session-package'
      )
      // Only retained upstream scopes keep a read-only marker. The new owner is writable.
      if (forkSource)
        await rm(join(destinationRoot, 'artifacts', projectId, sessionId, '.session-package'), {
          recursive: true,
          force: true
        })
      await mkdir(evidenceDirectory, { recursive: true })
      const files: SessionPackageReceipt['files'] = []
      const nativeInventory: SessionPackageManifest['inventory'] = []
      const verifyContent = createPackageContentVerifier()
      let verifiedFiles = 0
      const totalFiles = manifest.inventory.filter((entry) => entry.storageKey).length
      onProgress?.({
        phase: 'importing',
        importStage: 'verify-files',
        completedFiles: 0,
        totalFiles
      })
      for (const entry of manifest.inventory) {
        if (!entry.storageKey) continue
        const localStorageKey = remapStorageKey(entry.storageKey, native.identities)
        const localEntry = {
          path: localStorageKey,
          kind: entry.kind,
          ...(await verifyContent(
            join(destinationRoot, localStorageKey),
            PACKAGE_MAX_BYTES,
            this.signal
          ))
        }
        files.push({
          sourceStorageKey: entry.storageKey,
          sourceChecksum: entry.checksum,
          localStorageKey,
          localChecksum: localEntry.checksum
        })
        nativeInventory.push({
          ...entry,
          ...localEntry,
          storageKey: localStorageKey
        })
        onProgress?.({
          phase: 'importing',
          importStage: 'verify-files',
          completedFiles: ++verifiedFiles,
          totalFiles
        })
      }
      // Re-open derived evidence through the same native readers before publishing any authority.
      await validatePackageRecords(
        destinationRoot,
        {
          ...manifest,
          // Standard metadata describes the retained source archive. Native remapping below
          // validates destination records only; it neither copies nor rewrites that document.
          requiredFeatures: manifest.requiredFeatures?.filter((feature) => feature !== 'ro-crate'),
          source: { ...manifest.source, projectId, sessionId },
          excludedFiles: manifest.excludedFiles.map((file) => ({
            ...file,
            storageKey: remapStorageKey(file.storageKey, native.identities)
          })),
          inventory: nativeInventory
        },
        native.records,
        this.signal,
        manifest.source,
        undefined,
        onProgress,
        true
      )
      onProgress?.({ importStage: 'publish', phase: 'importing' })
      // Fork origin readers need only these two files. Leave the transfer in operation staging
      // so both successful publication and restart recovery retire its payloads.
      if (records.logEvidence || forkSource) {
        const metadata = join(evidenceDirectory, records.logEvidence ? 'origin-metadata' : 'source')
        await mkdir(metadata)
        for (const name of ['manifest.json', 'records.json'])
          await copyFile(join(sourceRoot, name), join(metadata, name))
      }
      if (!forkSource) await rename(sourceRoot, join(evidenceDirectory, 'source'))
      await writeDurableJsonFile(
        join(evidenceDirectory, 'receipt.json'),
        JSON.stringify(
          sessionPackageReceiptSchema.parse({
            schemaVersion: 1,
            ...(session.packageOrigin ?? session.forkOrigin),
            projectId,
            sessionId,
            ...(records.logEvidence ? { nativeLogOrigin: true } : {}),
            identities: native.identities,
            files
          })
        )
      )
      const directories: ImportJournal['directories'] = []
      for (const scope of [
        'artifacts',
        'uploads',
        'notebooks',
        'execution-file-evidence',
        'notebook-file-evidence',
        'file-evidence'
      ] as const) {
        const staged = join(destinationRoot, scope, projectId)
        if (!(await lstat(staged).catch(() => undefined))) continue
        for (const child of await readdir(staged)) {
          if (scope === 'execution-file-evidence' && child === 'blobs') continue
          directories.push({ scope, sessionId: child })
        }
      }
      journal = importJournalSchema.parse({
        schemaVersion: 1,
        projectId,
        sessionId,
        directories,
        ...(retryPlan ? { retryPlanName: basename(retryPlan.path) } : {})
      })
      // SessionRepository owns its encoding; capacity uses known journal bytes and the shared
      // reserve, without scanning its private storage or serializing the Session twice.
      const journalContents = JSON.stringify(journal)
      await assertPackageCapacity(configOperationRoot, Buffer.byteLength(journalContents))
      await new SessionRepository(sessionStage).saveSession(session)
      await this.syncTree(sessionStage)
      await defaultFileDurability.syncFile(join(operationRoot, '.session-package-owner'))
      await defaultFileDurability.syncDirectory(operationRoot)
      await writeDurableJsonFile(join(configOperationRoot, 'journal.json'), journalContents)
      await defaultFileDurability.syncDirectory(join(this.configRoot, 'session-package-imports'))
      for (const entry of journal.directories) {
        this.signal.throwIfAborted()
        const root = this.options.storageRoot
        const parent = join(root, entry.scope, projectId)
        if (entry.scope === 'execution-file-evidence')
          await ensureWorkingFileEvidenceProject(
            root,
            projectId,
            undefined,
            records.logEvidence ? operationId : undefined
          )
        else await mkdir(parent, { recursive: true })
        await assertPackageSourcePath(root, `${entry.scope}/${projectId}`)
        const directory = join(parent, entry.sessionId)
        // Reserve only the fresh remapped Session, never a whole existing Project.
        await mkdir(directory, { mode: 0o700 })
        await writeFile(join(directory, '.session-package-owner'), operationId, {
          flag: 'wx',
          mode: 0o600
        })
        await defaultFileDurability.syncFile(join(directory, '.session-package-owner'))
        await defaultFileDurability.syncDirectory(directory)
        await defaultFileDurability.syncDirectory(parent)
        const staged = join(destinationRoot, entry.scope, projectId, entry.sessionId)
        for (const child of await readdir(staged)) {
          if (child === '.session-package-owner')
            throw new Error('Session package contains a reserved ownership filename.')
          await rename(join(staged, child), join(directory, child))
        }
        await this.syncTree(directory)
        await defaultFileDurability.syncDirectory(join(root, entry.scope))
      }
      const poolKey = 'execution-file-evidence/' + projectId + '/blobs'
      const stagedPool = join(destinationRoot, poolKey)
      // Zero-generation activities still own log/view bytes under the project budget.
      if (records.logEvidence) await mkdir(stagedPool, { recursive: true, mode: 0o700 })
      if (
        await lstat(stagedPool).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        })
      ) {
        await updateImportedEvidencePool(
          'publish-imported-pool',
          this.options.storageRoot,
          projectId,
          stagedPool,
          this.signal
        )
      }
      const client = await this.options.getClient()
      const publishRecords = prepareNativePublication(native.records)
      this.signal.throwIfAborted()
      published = undefined
      await client.$transaction(async (transaction) => {
        if (target.projectId) await this.assertImportProject(projectId, transaction)
        else
          await transaction.project.create({
            data: {
              id: projectId,
              name: target.projectName ?? manifest.source.projectName,
              description: 'Imported research history'
            }
          })
        await publishRecords(transaction)
        if (forkSource)
          await copySessionBookmarks(
            transaction,
            { projectId: forkSource.projectId, sessionId: forkSource.id },
            { projectId, sessionId },
            (target) => {
              const source =
                'path' in target.source
                  ? {
                      ...target.source,
                      path: encodeDataPath(target.source.path, this.options.storageRoot)
                    }
                  : target.source
              const mapped = mapPackageReferences(
                source,
                bookmarkIdentities,
                '',
                native.checksums
              ) as BookmarkTarget['source']
              return {
                ...target,
                source:
                  'path' in mapped
                    ? { ...mapped, path: decodeDataPath(mapped.path, this.options.storageRoot) }
                    : mapped
              } as BookmarkTarget
            }
          )
        // An empty conversation needs the same commit witness as one carrying files.
        await transaction.fileOriginSession.upsert({
          where: { projectId_sessionId: { projectId, sessionId } },
          create: { projectId, sessionId, titleSnapshot: session.title },
          update: {}
        })
      })
      published = true
    } catch (error) {
      // A lost driver acknowledgement is not a failed import when SQLite proves the commit.
      // If that witness cannot be read, leave the journal and every payload for startup recovery.
      if (published === undefined) {
        try {
          const client = await this.options.getClient()
          published = Boolean(
            await client.fileOriginSession.findUnique({
              where: { projectId_sessionId: { projectId, sessionId } }
            })
          )
        } catch (witnessError) {
          if (forkSource)
            throw new ForkRecoveryRequiredError(
              { projectId, sessionId, operationId, outcome: 'unconfirmed' },
              witnessError
            )
          throw recoveryError(witnessError)
        }
      }
      if (published === false) {
        // Preserve validation/cancellation/transaction failure while exposing retryable cleanup.
        // Retry removes only this uncommitted import; it must never replay publication.
        return await withPackageCleanup(
          async () => {
            throw error
          },
          async () => {
            if (journal) await this.removeUnpublished(journal, operationId)
            if (preparedWebFork) await this.options.onForkAborted?.(preparedWebFork)
            await cleanupStaging()
          }
        )
      }
    }
    // Publication failures retain the journal; after publication retry only staging removal.
    try {
      await this.finishPublishedImport(configOperationRoot, operationId)
    } catch (error) {
      if (forkSource)
        throw new ForkRecoveryRequiredError(
          { projectId, sessionId, operationId, outcome: 'committed' },
          error
        )
      throw recoveryError(error)
    }
    return await withPackageCleanup(async () => ({ projectId, sessionId }), cleanupStaging)
  }

  // Call before catalog hydration. The imported origin row witnesses the native transaction.
  // Recovery removes only fresh Session directories carrying this operation's ownership marker.
  recover(options: { collectDeletedPackages?: boolean } = {}): Promise<void> {
    return this.serialize(async () => {
      await this.recoverNow()
      if (options.collectDeletedPackages) await this.deletion.recover(this.signal)
    })
  }

  private async recoverNow(onlyOperation?: string): Promise<void> {
    const counts = { inspected: 0, recovered: 0, retained: 0, failed: 0 }
    const diagnostic = startDiagnosticOperation(createLogger('session-package'), {
      operation: 'session-package.import-recovery'
    })
    let activeItem = false
    try {
      const root = join(this.configRoot, 'session-package-imports')
      const operations = await readdir(root).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      })
      for (const operation of operations) {
        if (onlyOperation && operation !== onlyOperation) continue
        this.signal.throwIfAborted()
        counts.inspected += 1
        activeItem = true
        // A disconnected root is a global recovery failure; never interpret it as missing payloads.
        if (!(await stat(this.options.storageRoot)).isDirectory())
          throw new Error('Session package data root is unavailable.')
        const stage = join(root, operation)
        const journalPath = join(stage, 'journal.json')
        let identity: ImportJournal | undefined
        try {
          if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(operation))
            throw new Error('Invalid Session package recovery identity.')
          await assertPackageSourcePath(this.configRoot, `session-package-imports/${operation}`)
          const journal = await lstat(journalPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined
            throw error
          })
          if (journal) {
            await assertPackageSourcePath(stage, 'journal.json')
            identity = importJournalSchema.parse(await readPackageJson(journalPath))
          }
        } catch (error) {
          counts.retained += 1
          counts.failed += 1
          activeItem = false
          createLogger('session-package').warn(
            'Invalid import journal retained; other imports will recover',
            diagnosticErrorFields(error)
          )
          continue
        }
        // Database and publication failures still propagate to the deferred data-root gate.
        if (identity) {
          const journal = identity
          await withWorkingFileEvidenceRead(
            this.options.storageRoot,
            journal.projectId,
            async () => {
              const client = await this.options.getClient()
              const committed = await client.fileOriginSession.findUnique({
                where: {
                  projectId_sessionId: {
                    projectId: journal.projectId,
                    sessionId: journal.sessionId
                  }
                }
              })
              if (!committed) await this.removeUnpublished(journal, operation)
              else await this.finishPublishedImport(stage, operation)
            }
          )
        }
        if (this.configRoot !== this.options.storageRoot) {
          const dataStage = join(this.options.storageRoot, 'session-package-imports', operation)
          if (await this.ownsDirectory(dataStage, operation))
            await rm(dataStage, { recursive: true, force: true })
        }
        await rm(join(root, operation), { recursive: true, force: true })
        await defaultFileDurability.syncDirectory(root)
        counts.recovered += 1
        activeItem = false
      }
    } catch (error) {
      if (activeItem) {
        counts.retained += 1
        counts.failed += 1
      }
      if (this.signal.aborted) diagnostic.cancel(counts)
      else diagnostic.fail(error, counts)
      throw error
    } finally {
      diagnostic.complete(counts)
    }
  }

  async readPdfNotes(request: ListPdfAnnotationsRequest): Promise<PdfAnnotationListResult> {
    if (!request.projectId || !request.sessionId)
      throw new Error('Package note scope is unavailable.')
    const origin = await this.readOrigin({
      projectId: request.projectId,
      sessionId: request.sessionId
    })
    const snapshots = namespacePackagePdfNotes(
      mapPackageReferences(origin.pdfNotes ?? [], origin.identities) as PackagePdfNotes,
      request.sessionId
    )
    const selected = snapshots.filter(
      (snapshot) => !request.versionId || snapshot.versionId === request.versionId
    )
    const tags = new Map(selected.flatMap((snapshot) => snapshot.tags).map((tag) => [tag.id, tag]))
    const annotations = [
      ...new Map(
        selected.flatMap((snapshot) => snapshot.annotations).map((note) => [note.id, note])
      ).values()
    ]
      .filter(
        (note) =>
          note.projectId === request.projectId &&
          (!request.sourceFileId || note.target.source.sourceFileId === request.sourceFileId) &&
          (!request.id || note.id === request.id)
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    const after = annotations.filter(
      (note) =>
        !request.cursor ||
        note.createdAt > request.cursor.createdAt ||
        (note.createdAt === request.cursor.createdAt && note.id > request.cursor.id)
    )
    const items = after.slice(0, request.limit ?? 50)
    const last = after.length > items.length ? items.at(-1) : undefined
    const source =
      request.versionId && selected.length
        ? await readPackagePdfSource(await this.options.getClient(), request)
        : undefined
    return {
      items,
      total: annotations.length,
      readonlyIds: items.map((note) => note.id),
      snapshotTags: [...tags.values()],
      ...(source ? { source } : {}),
      ...(source && selected[0]?.nativeImport ? { nativeImport: selected[0].nativeImport } : {}),
      ...(last ? { nextCursor: { createdAt: last.createdAt, id: last.id } } : {})
    }
  }

  async readResearchFilm(
    request: ResearchVideoPresentationRequest,
    options: { includeUnavailable?: boolean } = {}
  ): Promise<ResearchVideoPresentation | undefined> {
    const loaded = await loadSessionMutationAuthority(
      new SessionRepository(this.configRoot),
      request.projectId,
      request.sessionId
    )
    if (loaded.status !== 'found' || (!loaded.session.packageOrigin && !loaded.session.forkOrigin))
      return undefined
    const graph = loaded.session.conversationGraph
    const branchId =
      request.branchId ??
      graph?.frames.find((frame) => frame.id === graph.rootFrameId)?.activeBranchId
    const origin = await this.readOrigin({
      projectId: request.projectId,
      sessionId: request.sessionId
    })
    const films = mapPackageReferences(
      origin.researchFilms ?? [],
      origin.identities
    ) as PackageResearchFilms
    const film = films.find(
      (film) =>
        film.branchId === branchId &&
        (film.mode ?? 'research-explanation') === (request.mode ?? 'research-explanation')
    )
    if (!film) return undefined
    if (!options.includeUnavailable) {
      for (const key of [film.playerStorageKey, film.sourceStorageKey]) {
        const exists = await assertPackageSourcePath(this.options.storageRoot, key).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return false
            throw error
          }
        )
        if (!exists) return undefined
        if (!(await lstat(join(this.options.storageRoot, key))).isFile())
          throw new Error('Research presentation is unavailable.')
      }
    }
    const playerPath = join(this.options.storageRoot, film.playerStorageKey)
    return {
      ...(!options.includeUnavailable && (await readResearchFilmCard(playerPath))),
      id: film.id,
      title: film.title,
      duration: film.duration,
      playerPath,
      sourcePath: join(this.options.storageRoot, film.sourceStorageKey)
    }
  }

  /** Read-only film evidence; imported jobs remain history and acquire no execution authority. */
  async readFilmEvidence(session: PersistedChatSession): Promise<ReplayRecords> {
    const scope = { projectId: session.projectId, sessionId: session.id }
    const [reviews, jobs, origin] = await Promise.all([
      new ReviewRepository(this.options.getClient).getReviewSummariesForProjectSession(
        scope.projectId,
        scope.sessionId
      ),
      new ComputeJobRepository(this.options.getClient).findByOwner(scope),
      session.packageOrigin || session.forkOrigin ? this.readOrigin(scope) : undefined
    ])
    const inherited = origin
      ? (mapPackageReferences(
          origin.history?.computeJobs ?? [],
          origin.identities
        ) as NonNullable<PackageHistory>['computeJobs'])
      : []
    if (reviews.length + jobs.length + inherited.length > 2000)
      throw new Error('Too many records for an operation replay.')
    return {
      reviews: reviews.map((r) => ({
        id: r.id,
        messageId: r.turnMessageId,
        status: r.outcome ?? r.lifecycle,
        text: JSON.stringify({
          scope: r.scope,
          lifecycle: r.lifecycle,
          outcome: r.outcome,
          error: r.errorMessage,
          checks: r.checks
        }),
        recordedAt: r.createdAt
      })),
      jobs: [
        ...inherited.map((j) => ({
          id: j.id,
          status: j.status,
          text: JSON.stringify({
            command: j.command,
            stdout: j.stdout,
            stderr: j.stderr,
            exitCode: j.exitCode,
            unavailable: j.protectedContentUnavailable
          }),
          producerRunId: j.producerRunId,
          recordedAt: j.createdAt
        })),
        ...jobs.map((j) => ({
          id: j.job_id,
          status: j.status,
          text: JSON.stringify({
            command: j.command,
            stdout: j.stdout_tail,
            stderr: j.stderr_tail,
            exitCode: j.exit_code,
            error: j.error_code
          }),
          producerRunId: j.producer_run_id,
          recordedAt: j.created_at
        }))
      ]
    }
  }

  async readOrigin(request: SessionPackageRequest): Promise<{
    nativeLogOrigin?: true
    sourceManifest: SessionPackageManifest
    identities: Record<string, string>
    files: SessionPackageReceipt['files']
    history?: PackageHistory
    literature?: import('./literature').PackageLiterature
    pdfNotes?: PackagePdfNotes
    researchFilms?: PackageResearchFilms
    webEvidence?: PackageRecords['webEvidence']
    originSessionIds: string[]
    logSessionIds: string[]
  }> {
    const safe = sessionPackageRequestSchema.parse(request)
    const root = join(this.options.storageRoot, 'artifacts', safe.projectId, safe.sessionId)
    const forkReceipt = await lstat(join(root, '.session-fork')).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      }
    )
    const directory = join(root, forkReceipt ? '.session-fork' : '.session-package')
    const receipt = sessionPackageReceiptSchema.parse(
      await readPackageJson(join(directory, 'receipt.json'))
    )
    const metadataDirectory = receipt.nativeLogOrigin ? 'origin-metadata' : 'source'
    if (
      receipt.projectId !== safe.projectId ||
      receipt.sessionId !== safe.sessionId ||
      receipt.manifestChecksum !==
        (await fileChecksum(join(directory, metadataDirectory, 'manifest.json')))
    )
      throw new Error('Session package receipt integrity mismatch.')
    const sourceManifest = sessionPackageManifestSchema.parse(
      await readPackageJson(join(directory, metadataDirectory, 'manifest.json'))
    )
    if (
      sourceManifest.source.projectId !== receipt.sourceProjectId ||
      sourceManifest.source.sessionId !== receipt.sourceSessionId
    )
      throw new Error('Session package receipt source identity mismatch.')
    const recordsEntry = sourceManifest.inventory.find((entry) => entry.path === 'records.json')
    if (
      recordsEntry?.checksum !==
      (await fileChecksum(join(directory, metadataDirectory, 'records.json')))
    )
      throw new Error('Session package source records checksum mismatch.')
    const records = parseNativeRecords(
      await readPackageJson(join(directory, metadataDirectory, 'records.json'))
    )
    return {
      nativeLogOrigin: receipt.nativeLogOrigin,
      sourceManifest,
      identities: receipt.identities,
      files: receipt.files,
      history: records.history,
      literature: records.literature,
      pdfNotes: records.pdfNotes,
      researchFilms: packageFilms(records),
      webEvidence: records.webEvidence,
      logSessionIds: [
        ...new Set(
          (records.logEvidence ?? []).map((lane) => receipt.identities[lane.key.split('/')[2]])
        )
      ],
      originSessionIds: records.tables.FileOriginSession.map(
        (row) => receipt.identities[String(row.sessionId)]
      )
    }
  }

  private async assertImportProject(
    projectId: string,
    client?: import('@prisma/client').Prisma.TransactionClient | PrismaClient
  ): Promise<void> {
    const database = client ?? (await this.options.getClient())
    const project = await database.project.findUnique({ where: { id: projectId } })
    const deleting = await database.projectDeletionIntent.findUnique({ where: { projectId } })
    if (!project || project.deletedAt || project.archivedAt || deleting)
      throw new Error('The import destination project is no longer available.')
  }

  private async ownsDirectory(directory: string, operation: string): Promise<boolean> {
    const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!info?.isDirectory() || info.isSymbolicLink()) return false
    const marker = await readFile(join(directory, '.session-package-owner'), 'utf8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      }
    )
    return marker === operation
  }

  private async removeUnpublished(journal: ImportJournal, operation: string): Promise<void> {
    return withWorkingFileEvidenceRead(this.options.storageRoot, journal.projectId, async () => {
      for (const entry of journal.directories) {
        const parent = join(this.options.storageRoot, entry.scope, journal.projectId)
        const directory = join(parent, entry.sessionId)
        if (!(await this.ownsDirectory(directory, operation))) continue
        await assertPackageSourcePath(
          this.options.storageRoot,
          `${entry.scope}/${journal.projectId}/${entry.sessionId}`
        )
        await rm(directory, { recursive: true, force: true })
        await defaultFileDurability.syncDirectory(parent)
      }
      const root = this.options.storageRoot
      const stage = join(root, 'session-package-imports', operation)
      const pool = join(stage, 'destination', 'execution-file-evidence', journal.projectId, 'blobs')
      if (await this.ownsDirectory(stage, operation)) {
        const receipt = await lstat(join(pool, '.import-pool-receipt.json')).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
          }
        )
        if (receipt)
          await updateImportedEvidencePool('rollback-imported-pool', root, journal.projectId, pool)
        if (
          journal.retryPlanName &&
          journal.directories.some((entry) => entry.scope === 'execution-file-evidence')
        )
          await releaseImportedEvidenceProject(root, journal.projectId, operation)
      }
    })
  }

  private async finishPublishedImport(
    operationRoot: string,
    operation: string,
    knownIdentity?: ImportJournal
  ): Promise<void> {
    const identity =
      knownIdentity ??
      importJournalSchema.parse(await readPackageJson(join(operationRoot, 'journal.json')))
    const retirePlan = async (): Promise<void> => {
      if (!identity.retryPlanName) return
      const directory = join(this.configRoot, 'session-package-log-retries')
      const path = join(directory, identity.retryPlanName)
      const raw = await readPackageJson(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
      if (!raw) return
      const plan = logIdentityPlanSchema.parse(raw)
      // Recovery of an old operation must leave a later allocation for the same input intact.
      if (plan.operationId !== operation) return
      if (plan.projectId !== identity.projectId || plan.sessionId !== identity.sessionId)
        throw new Error('Import retry allocation identity mismatch.')
      await rm(path, { force: true })
      await defaultFileDurability.syncDirectory(directory)
    }
    const client = await this.options.getClient()
    const projected = await client.session.findUnique({ where: { id: identity.sessionId } })
    if (projected && projected.projectId !== identity.projectId)
      throw new Error('Import publication Session identity mismatch.')
    // A cleanup retry cannot revive a Session deleted after successful publication.
    if (projected?.deletedAtMs != null) return retirePlan()
    const repository = new SessionRepository(
      this.configRoot,
      {},
      new SessionProjectionRepository(this.options.getClient)
    )
    const publish = async (saved: PersistedChatSession): Promise<void> => {
      if (
        saved.id !== identity.sessionId ||
        saved.projectId !== identity.projectId ||
        (saved.packageOrigin ?? saved.forkOrigin)?.importId !== operation
      )
        throw new Error('Import publication Session identity mismatch.')
      const pendingProjectImport =
        identity.projectId === `import-${operation}` &&
        saved.packageOrigin?.importId === operation &&
        (await isSessionPackagePending(this.configRoot, identity.projectId))
          ? { operationId: operation }
          : undefined
      await this.options.onSessionPublished?.({
        projectId: identity.projectId,
        sessionId: identity.sessionId,
        session: saved,
        ...(pendingProjectImport ? { pendingProjectImport } : {})
      })
    }
    const work = (): Promise<PersistedChatSession> =>
      this.prepareSessionPublication(repository, identity, operationRoot, operation)
    const saved = this.options.runSessionPublication
      ? await this.options.runSessionPublication(identity.projectId, identity.sessionId, work)
      : await work()
    // Adoption also enters the owner lane, so publish only after the complete write has released it.
    await publish(saved)
    await retirePlan()
    // Keep the directory claims after publication. Startup package deletion requires these exact
    // import identities before it can retire any native scope, including retained upstream scopes.
  }

  private async prepareSessionPublication(
    repository: SessionRepository,
    identity: ImportJournal,
    operationRoot: string,
    operation: string
  ): Promise<PersistedChatSession> {
    // The live owner serializes this entire decision with normal saves and deletion, including
    // missing authority that needs to be published from stage for the first time.
    await repository.assertSessionIdentityOwnership(identity.sessionId, identity.projectId)
    const current = await loadSessionMutationAuthority(
      repository,
      identity.projectId,
      identity.sessionId
    )
    if (current.status === 'unreadable')
      throw new Error('Import publication Session cannot be read safely.')
    if (current.status === 'found') {
      if ((current.session.packageOrigin ?? current.session.forkOrigin)?.importId !== operation)
        throw new Error('Import publication Session identity mismatch.')
      return repository.saveSession(current.session)
    }
    let session = await new SessionRepository(join(operationRoot, 'session-stage')).loadSession(
      identity.projectId,
      identity.sessionId
    )
    if (!session || (session.packageOrigin ?? session.forkOrigin)?.importId !== operation)
      throw new Error('Import publication Session is missing or invalid.')
    // A failed workspace ownership commit may have released the staged directory. Recovery
    // allocates a fresh workspace instead of publishing the now-missing provisional path.
    const missingForkWorkspace =
      session.forkOrigin &&
      session.cwd.startsWith(join(this.options.storageRoot, 'workspaces') + sep)
        ? !(await stat(session.cwd).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined
            throw error
          }))
        : false
    if (session.forkOrigin && (!session.cwd || missingForkWorkspace)) {
      const workspace = await createManagedSessionWorkspaceCapability({
        resolveRoot: () => this.options.storageRoot
      }).acquire({ projectId: session.projectId })
      try {
        session = { ...session, cwd: workspace.cwd }
        await new SessionRepository(join(operationRoot, 'session-stage')).saveSession(session)
        await workspace.commit(session.id)
      } finally {
        await workspace.release()
      }
    }
    // Live Session authority appears only after native records commit. Recovery repeats the
    // same repository publication; it never republishes records or replaces another Session.
    return repository.saveSession(session)
  }
  private async syncTree(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await this.syncTree(path)
      else if (entry.isFile()) await defaultFileDurability.syncFile(path)
      else throw new Error('Import staging contains a link or special file.')
    }
    await defaultFileDurability.syncDirectory(directory)
  }
  private assertIdentity(manifest: SessionPackageManifest, session: PersistedChatSession): void {
    if (manifest.source.projectId !== session.projectId || manifest.source.sessionId !== session.id)
      throw new Error('Session package source identity mismatch.')
  }
}
