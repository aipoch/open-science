import { assertSettledHistory, readSession, preview, inspectSessionPackage } from './inspection'
import {
  capturePackageReproducibility,
  installPackageReproducibility,
  packageReproducibilityExclusions,
  packageReproducibilityKeys
} from './reproducibility'
import { z } from 'zod'
import { withPackageCleanup } from './cleanup'
import { withPackageTransfer } from './transfer'
import { paceFileIo } from '../file-io-pacing'
import { createLogger, diagnosticErrorFields } from '../logger'
import { startDiagnosticOperation } from '../diagnostics/operation'
import type { PrismaClient } from '@prisma/client'
import type { NotebookRunDocument } from '../../shared/notebook'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { createReadStream } from 'node:fs'
import {
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
import { join } from 'node:path'
import { sha256 } from '../artifacts/provenance-canonical'
import { resolveStorageKey } from '../artifacts/provenance-storage'
import {
  captureNativeRecords,
  mapPackageReferences,
  nativeStorageKeys,
  notebookStorageKeys,
  notebookDocumentIdentity,
  parseNativeRecords,
  prepareNativeImport,
  prepareNativePublication,
  remapStorageKey,
  readPackageNotebooks,
  sessionFileVersionIds
} from './native-snapshot'
import { tmpdir } from 'node:os'
import {
  sessionPackageRequestSchema,
  sessionPackageImportRequestSchema,
  type SessionPackageImportRequest,
  sessionPackageManifestSchema,
  sessionPackageReceiptSchema,
  type SessionPackageReceipt,
  type SessionPackageRequest,
  type SessionPackagePreview,
  type SessionPackageManifest
} from '../../shared/session-package'
import type {
  PackageSelectableFile,
  PackageSelectionSummary,
  PackageProgress
} from '../../shared/session-package'
import {
  selectablePackageFiles,
  markRequiredPackageFiles,
  validateExcludedFiles,
  assertNoExcludedContentCopies,
  excludedNotebookInputCopy,
  isNotebookInputCopy
} from './selection'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { redactSensitiveText, isSensitiveDiagnosticKey } from '../../shared/diagnostic-redaction'
import { SessionRepository, loadSessionMutationAuthority } from '../session-persistence/repository'
import { defaultFileDurability } from '../storage/file-durability'
import { writeDurableJsonFile } from '../storage/durable-json-file'
import {
  fileChecksum,
  assertPackageSourcePath,
  packageEntry,
  readPackageJson,
  validatePackageDirectory,
  writePackageArchive
} from './archive'
import { assertPortablePackageStorageKey, validatePackageRecords } from './validation'
import { encodeSessionDataPaths } from '../session-persistence/session-data-paths'
import { publishUserFile } from '../user-file-publisher'
import { PACKAGE_MAX_BYTES, PACKAGE_MAX_FILE_BYTES } from '../../shared/session-package'
import { capturePackageHistory, type PackageHistory } from './history'
import { SessionProjectionRepository } from '../session-persistence/projection'
import { copyFileWithinBudget, digestFileWithinBudget } from '../bounded-file-io'
import { executionEvidenceKeys } from './execution-evidence'
import { assertPackageCapacity } from './capacity'
import { ensureWorkingFileEvidenceProject } from '../notebook/working-file-observer'
import { SessionPackageDeletion } from './deletion'

const importJournalSchema = sessionPackageRequestSchema
  .extend({
    schemaVersion: z.literal(1),
    directories: z
      .array(
        z
          .object({
            scope: z.enum(['artifacts', 'uploads', 'notebooks', 'execution-file-evidence']),
            sessionId: sessionPackageRequestSchema.shape.sessionId
          })
          .strict()
      )
      .max(10000)
  })
  .strict()
type ImportJournal = z.infer<typeof importJournalSchema>

const PACKAGE_README =
  '# Open Science Session package\n\nOpen Science can inspect and import this archive as read-only research history. Import does not execute code or restore account credentials. Checksums verify bytes, not scientific claims or the identity of the sender.\n'

type PackageOptions = {
  storageRoot: string
  configRoot?: string
  getClient: () => Promise<PrismaClient>
  isSessionActive?: (projectId: string, sessionId: string) => boolean
  inspectPackage?: typeof inspectSessionPackage
}

type PackageExportOptions = {
  selectFiles?: (
    files: PackageSelectableFile[],
    signal: AbortSignal,
    summary: PackageSelectionSummary,
    title: string
  ) => Promise<readonly string[]>
  signal?: AbortSignal
  onProgress?: (progress: PackageProgress) => void
}

// Strip only known runtime metadata. A similarly named key inside research evidence must be
// inspected and rejected when sensitive, never silently removed from the evidence.
const withoutPrivateAuthority = (session: PersistedChatSession): PersistedChatSession => ({
  ...session,
  providerSessionId: undefined,
  providerContinuityToken: undefined,
  runtimeContext: session.runtimeContext
    ? {
        ...session.runtimeContext,
        permission: undefined,
        sideChat: session.runtimeContext.sideChat
          ? {
              ...session.runtimeContext.sideChat,
              providerSessionId: undefined,
              providerContinuityToken: undefined
            }
          : undefined
      }
    : undefined
})

// Recognizers stop export; they never silently rewrite research text. File preview is still
// necessary: arbitrary binary research data cannot be certified free of private information.
function* inspectShareable(value: unknown): Generator<number> {
  if (typeof value === 'string') {
    if (redactSensitiveText(value) !== value)
      throw new Error('Sensitive content detected. Remove it before exporting the Session package.')
    yield value.length + 1
  } else if (Array.isArray(value)) {
    yield 1
    for (const item of value) yield* inspectShareable(item)
  } else if (value && typeof value === 'object') {
    yield 1
    for (const [key, item] of Object.entries(value)) {
      if (isSensitiveDiagnosticKey(key) && typeof item === 'string' && item.trim())
        throw new Error(
          'Sensitive content detected. Remove it before exporting the Session package.'
        )
      yield key.length
      yield* inspectShareable(item)
    }
  } else {
    yield 1
  }
}

const assertShareable = async (value: unknown, signal?: AbortSignal): Promise<void> => {
  signal?.throwIfAborted()
  let work = 0
  for (const units of inspectShareable(value)) {
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

const assertShareableFile = async (path: string, signal?: AbortSignal): Promise<void> => {
  let tail = ''
  for await (const chunk of createReadStream(path, {
    encoding: 'utf8',
    highWaterMark: 64 * 1024,
    signal
  })) {
    await paceFileIo(Buffer.byteLength(chunk), signal)
    const text = tail + chunk
    await assertShareable(text, signal)
    tail = text.slice(-8192)
  }
}

export class SessionPackageService {
  // Imports and recovery share one owner. A recovery call must never reap live staging.
  private operationTail: Promise<unknown> = Promise.resolve()
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
    if (!session.packageOrigin) return
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
            '.session-package',
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
    await this.deletion.prepare(session, receipt, origin.originSessionIds)
  }

  private serialize<Result>(work: () => Promise<Result>, signal?: AbortSignal): Promise<Result> {
    if (this.closed) return Promise.reject(new Error('Session package service is closed.'))
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
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
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
  ): Promise<readonly string[]> {
    if (files.length > 10000 || summary.retainedFiles.length > 10000)
      throw new Error('Session package exceeds the file count limit.')
    const excluded = options.selectFiles
      ? await this.waitForUser(() => options.selectFiles!(files, this.signal, summary, title))
      : []
    const keys = new Set(excluded)
    if (files.some((file) => file.requiredForEvidence && keys.has(file.storageKey)))
      throw new Error(
        'An excluded file also exists in retained research evidence. Include that file to export this Session.'
      )
    return excluded
  }

  async close(): Promise<void> {
    this.closed = true
    this.shutdown.abort(new Error('Session package service is closed.'))
    await this.operationTail
  }

  private get configRoot(): string {
    return this.options.configRoot ?? this.options.storageRoot
  }

  async assertExportIdle(request: SessionPackageRequest): Promise<void> {
    const safe = sessionPackageRequestSchema.parse(request)
    const loaded = await loadSessionMutationAuthority(
      new SessionRepository(this.configRoot),
      safe.projectId,
      safe.sessionId
    )
    if (loaded.status !== 'found') throw new Error('Session not found or unreadable.')
    assertSettledHistory(loaded.session)
    if (this.options.isSessionActive?.(safe.projectId, safe.sessionId))
      throw new Error('The Session is still active.')
  }

  exportTo(
    rawRequest: SessionPackageRequest,
    path: string,
    options: PackageExportOptions = {}
  ): Promise<SessionPackagePreview> {
    return this.serialize(() => this.exportNow(rawRequest, path, options), options.signal)
  }

  private async exportNow(
    rawRequest: SessionPackageRequest,
    path: string,
    options: PackageExportOptions
  ): Promise<SessionPackagePreview> {
    const request = sessionPackageRequestSchema.parse(rawRequest)
    const sessions = new SessionRepository(this.configRoot)
    const loaded = await loadSessionMutationAuthority(
      sessions,
      request.projectId,
      request.sessionId
    )
    if (loaded.status !== 'found') throw new Error('Session not found or unreadable.')
    const session = loaded.session
    assertSettledHistory(session)
    if (session.packageOrigin) {
      // Forward the retained source package, never relabel locally derived hashes as original.
      const origin = await this.readOrigin(request)
      const source = join(
        this.options.storageRoot,
        'artifacts',
        request.projectId,
        request.sessionId,
        '.session-package',
        'source'
      )
      const manifest = await validatePackageDirectory(source, this.signal)
      if (manifest.source.projectId !== origin.sourceManifest.source.projectId)
        throw new Error('Session package source identity mismatch.')
      await assertShareable(manifest, this.signal)
      await assertShareable(await readPackageJson(join(source, 'session.json')), this.signal)
      const records = parseNativeRecords(await readPackageJson(join(source, 'records.json')))
      await assertShareable(records, this.signal)
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
      const selectable = selectablePackageFiles(records, notebooks).filter(
        (file) => !alreadyExcluded.has(file.storageKey)
      )
      const optionalKeys = new Set(
        [...selectable, ...inheritedExclusions].map((file) => file.storageKey)
      )
      const excluded = new Set(
        await this.chooseFiles(
          options,
          markRequiredPackageFiles(
            records,
            selectable,
            manifest.inventory.filter(
              (entry) => !entry.storageKey || !optionalKeys.has(entry.storageKey)
            )
          ),
          {
            metadataBytes: manifest.inventory
              .filter((entry) => !entry.storageKey)
              .reduce((sum, entry) => sum + entry.sizeBytes, 0),
            retainedFiles: manifest.inventory
              .filter((entry) => entry.storageKey && !optionalKeys.has(entry.storageKey))
              .map((entry) => ({
                storageKey: entry.storageKey!,
                filename: entry.storageKey!,
                sizeBytes: entry.sizeBytes
              }))
          },
          session.title
        )
      )
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
      const forwarded = {
        ...manifest,
        inventory: manifest.inventory.filter(
          (entry) => !entry.storageKey || !excluded.has(entry.storageKey)
        ),
        excludedFiles: [...manifest.excludedFiles, ...additional]
      }
      assertNoExcludedContentCopies(records, forwarded.excludedFiles, forwarded.inventory)
      const staging = await mkdtemp(join(tmpdir(), 'open-science-package-forward-'))
      return withPackageCleanup(
        async () => {
          await assertPackageCapacity(
            staging,
            forwarded.inventory.reduce((sum, entry) => sum + entry.sizeBytes, 0)
          )
          await mkdir(join(staging, 'objects'))
          for (const entry of forwarded.inventory) {
            this.signal.throwIfAborted()
            await assertShareableFile(join(source, entry.path), this.signal)
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
          await writeFile(join(staging, 'manifest.json'), JSON.stringify(forwarded))
          options.onProgress?.({ phase: 'validating' })
          await validatePackageDirectory(staging, this.signal)
          await validatePackageRecords(staging, forwarded, records, this.signal)
          options.onProgress?.({ phase: 'compressing' })
          await publishUserFile(path, (temporary) =>
            writePackageArchive(staging, temporary, this.signal)
          )
          return preview(forwarded, await readSession(source))
        },
        () => rm(staging, { recursive: true, force: true })
      )
    }
    const assertSettled = (): void => {
      assertSettledHistory(session)
      if (this.options.isSessionActive?.(request.projectId, request.sessionId))
        throw new Error('Wait for the Session to finish before exporting it.')
    }
    assertSettled()
    const client = await this.options.getClient()
    const project = await client.project.findUniqueOrThrow({ where: { id: request.projectId } })
    const notebookKeys = await notebookStorageKeys(this.options.storageRoot, request)
    const notebooks = await readPackageNotebooks(this.options.storageRoot, notebookKeys)
    const versionIds = [
      ...new Set([
        ...sessionFileVersionIds(session),
        ...notebooks.flatMap((document) =>
          document.runs.flatMap((run) =>
            (run.inputFiles ?? []).map((input) => input.inputFileVersionId)
          )
        )
      ])
    ]
    const records = await captureNativeRecords(client, request, versionIds)
    const history = await capturePackageHistory(this.configRoot, this.options.getClient, request)
    records.history = history
    records.reproducibility = await capturePackageReproducibility(
      this.options.storageRoot,
      records,
      request,
      this.signal
    )
    const inheritedExclusions = packageReproducibilityExclusions(records)
    const selectable = selectablePackageFiles(records, notebooks)
    const executionKeys = await executionEvidenceKeys(
      this.options.storageRoot,
      records,
      notebooks,
      this.signal
    )
    const sharedSession = encodeSessionDataPaths(
      withoutPrivateAuthority(session),
      this.options.storageRoot
    )
    const optionalKeys = new Set(
      [...selectable, ...inheritedExclusions].map((file) => file.storageKey)
    )
    const retainedFiles: PackageSelectionSummary['retainedFiles'] = []
    for (const key of new Set([
      ...nativeStorageKeys(records),
      ...notebookKeys,
      ...executionKeys,
      ...packageReproducibilityKeys(records)
    ])) {
      if (optionalKeys.has(key)) continue
      this.signal.throwIfAborted()
      await assertPackageSourcePath(this.options.storageRoot, key)
      retainedFiles.push({
        storageKey: key,
        filename: key,
        sizeBytes: (await lstat(resolveStorageKey(this.options.storageRoot, key))).size
      })
    }
    const sessionJson = JSON.stringify({ version: 2, session: sharedSession })
    const recordsJson = JSON.stringify(records)
    const metadataBytes =
      Buffer.byteLength(sessionJson) +
      Buffer.byteLength(recordsJson) +
      Buffer.byteLength(PACKAGE_README)
    const excludedKeys = new Set([
      ...(await this.chooseFiles(
        options,
        markRequiredPackageFiles(records, selectable, [
          ...retainedFiles,
          ...[sessionJson, recordsJson, PACKAGE_README].map((content) => ({
            sizeBytes: Buffer.byteLength(content),
            checksum: sha256(content)
          }))
        ]),
        { retainedFiles, metadataBytes },
        session.title
      )),
      ...inheritedExclusions.map((file) => file.storageKey)
    ])
    const excludedFiles = [...selectable, ...inheritedExclusions]
      .filter((file) => excludedKeys.has(file.storageKey))
      .map(({ storageKey, filename, sizeBytes }) => ({ storageKey, filename, sizeBytes }))
    if (excludedKeys.size !== excludedFiles.length)
      throw new Error('Invalid package content selection.')
    validateExcludedFiles(records, excludedFiles)
    await assertShareable(sharedSession, this.signal)
    const directory = await mkdtemp(join(tmpdir(), 'open-science-package-export-'))
    return withPackageCleanup(
      async () => {
        await assertShareable(records, this.signal)
        let totalBytes = metadataBytes
        const storageKeys = [
          ...new Set([
            ...nativeStorageKeys(records),
            ...notebookKeys,
            ...executionKeys,
            ...packageReproducibilityKeys(records)
          ])
        ].filter((key) => !excludedKeys.has(key))
        const sizes = new Map<string, number>()
        for (const key of storageKeys) {
          await assertPackageSourcePath(this.options.storageRoot, key)
          const original = resolveStorageKey(this.options.storageRoot, key)
          const metadata = await lstat(original)
          if (
            isNotebookInputCopy(key) &&
            excludedFiles.some((file) => file.sizeBytes === metadata.size)
          ) {
            const digest = await digestFileWithinBudget(original, metadata.size, this.signal)
            const omittedInput = excludedNotebookInputCopy(records, excludedFiles, {
              ...digest,
              storageKey: key
            })
            if (omittedInput) {
              excludedFiles.push(omittedInput)
              continue
            }
          }
          sizes.set(key, metadata.size)
        }
        const selectedBytes = [...sizes.values()].reduce((sum, size) => sum + size, 0)
        if (selectedBytes + totalBytes > PACKAGE_MAX_BYTES)
          throw new Error('Session package exceeds the export limit.')
        await assertPackageCapacity(directory, selectedBytes + metadataBytes)
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
        for (const storageKey of sizes.keys()) {
          assertPortablePackageStorageKey(storageKey)
          await assertPackageSourcePath(this.options.storageRoot, storageKey)
          const original = resolveStorageKey(this.options.storageRoot, storageKey)
          const metadata = await lstat(original)
          if (!metadata.isFile() || metadata.size > PACKAGE_MAX_FILE_BYTES)
            throw new Error('Invalid or oversized package source file.')
          totalBytes += metadata.size
          if (totalBytes > PACKAGE_MAX_BYTES || inventory.length >= 10000)
            throw new Error('Session package exceeds the export limit.')
          const objectPath = `objects/${sha256(storageKey)}`
          const copied = await copyFileWithinBudget(
            original,
            join(directory, objectPath),
            metadata.size,
            this.signal,
            (bytes) =>
              options.onProgress?.({
                phase: 'copying',
                completedBytes: completedBytes + bytes,
                totalBytes: selectedBytes,
                completedFiles,
                totalFiles: sizes.size,
                currentFile:
                  selectable.find((file) => file.storageKey === storageKey)?.filename ?? storageKey
              })
          )
          completedBytes += copied.sizeBytes
          completedFiles += 1
          if (copied.sizeBytes !== metadata.size)
            throw new Error('The Session changed during export. Try again.')
          assertNoExcludedContentCopies(records, excludedFiles, [copied])
          await assertShareableFile(join(directory, objectPath), this.signal)
          inventory.push({
            path: objectPath,
            kind: notebookKeys.includes(storageKey) ? 'notebook' : 'file',
            ...copied,
            storageKey
          })
        }
        const manifest: SessionPackageManifest = {
          format: 'open-science-session',
          schemaVersion: 1,
          createdAt: Date.now(),
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
        await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
        options.onProgress?.({ phase: 'validating' })
        await validatePackageRecords(directory, manifest, records, this.signal)
        assertSettled()
        if (
          JSON.stringify(await notebookStorageKeys(this.options.storageRoot, request)) !==
          JSON.stringify(notebookKeys)
        )
          throw new Error('The Session changed during export. Try again.')
        for (const entry of inventory) {
          if (!entry.storageKey) continue
          await assertPackageSourcePath(this.options.storageRoot, entry.storageKey)
          const currentFile = await digestFileWithinBudget(
            resolveStorageKey(this.options.storageRoot, entry.storageKey),
            entry.sizeBytes,
            this.signal
          )
          if (currentFile.sizeBytes !== entry.sizeBytes || currentFile.checksum !== entry.checksum)
            throw new Error('The Session changed during export. Try again.')
        }
        const current = await loadSessionMutationAuthority(
          sessions,
          request.projectId,
          request.sessionId
        )
        const currentRecords = await captureNativeRecords(client, request, versionIds)
        currentRecords.history = await capturePackageHistory(
          this.configRoot,
          this.options.getClient,
          request
        )
        currentRecords.reproducibility = await capturePackageReproducibility(
          this.options.storageRoot,
          currentRecords,
          request,
          this.signal
        )
        if (
          current.status !== 'found' ||
          !isDeepStrictEqual(current.session, session) ||
          !isDeepStrictEqual(currentRecords, records)
        )
          throw new Error('The Session changed during export. Try again.')
        options.onProgress?.({ phase: 'compressing' })
        await publishUserFile(path, (temporaryPath) =>
          writePackageArchive(directory, temporaryPath, this.signal)
        )
        return preview(manifest, session)
      },
      () => rm(directory, { recursive: true, force: true })
    )
  }

  inspect(path: string, signal?: AbortSignal): Promise<SessionPackagePreview> {
    return this.serialize(() => this.inspectNow(path), signal)
  }

  private async inspectNow(path: string): Promise<SessionPackagePreview> {
    const directory = await mkdtemp(join(tmpdir(), 'open-science-package-inspect-'))
    return withPackageCleanup(
      () => (this.options.inspectPackage ?? inspectSessionPackage)(path, directory, this.signal),
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
    target: SessionPackageImportRequest
  ): Promise<{ projectId: string; sessionId: string }> {
    if (target.projectId) await this.assertImportProject(target.projectId)
    const operationId = randomUUID()
    const projectId = target.projectId ?? `import-${operationId}`
    const sessionId = `import-${randomUUID()}`
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
    let journal: ImportJournal | undefined
    try {
      await writeFile(join(operationRoot, '.session-package-owner'), operationId, { flag: 'wx' })
      const inspected = await (this.options.inspectPackage ?? inspectSessionPackage)(
        path,
        sourceRoot,
        this.signal
      )
      if (confirm) await this.waitForUser(() => confirm(inspected, this.signal))
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
      const native = await prepareNativeImport(
        sourceRoot,
        destinationRoot,
        manifest,
        records,
        projectId,
        sessionId,
        sourceSession,
        this.signal,
        onProgress
      )
      await installPackageReproducibility(
        destinationRoot,
        native.records,
        new Set(
          manifest.excludedFiles.map((file) => remapStorageKey(file.storageKey, native.identities))
        )
      )
      const manifestChecksum = await fileChecksum(join(sourceRoot, 'manifest.json'))
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
      const mappedSession = withoutPrivateAuthority(
        mapPackageReferences(
          sourceSession,
          native.identities,
          '',
          native.checksums
        ) as PersistedChatSession
      )
      const session: PersistedChatSession = {
        ...mappedSession,
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
              sideChatRelays: undefined,
              plan: mappedSession.runtimeContext.plan
                ? { ...mappedSession.runtimeContext.plan, delivery: undefined }
                : undefined
            }
          : undefined,
        activeRun: undefined,
        taskRunCommitId: undefined,
        resumeRecovery: undefined,
        pendingHistoryReplay: undefined,
        packageOrigin: {
          importId: operationId,
          sourceProjectId: sourceSession.projectId,
          sourceSessionId: sourceSession.id,
          importedAt: Date.now(),
          manifestChecksum,
          excludedFiles: manifest.excludedFiles
        }
      }
      const sessionStage = join(configOperationRoot, 'session-stage')
      const evidenceDirectory = join(
        destinationRoot,
        'artifacts',
        projectId,
        sessionId,
        '.session-package'
      )
      await mkdir(evidenceDirectory, { recursive: true })
      const files: SessionPackageReceipt['files'] = []
      const nativeInventory: SessionPackageManifest['inventory'] = []
      for (const entry of manifest.inventory) {
        if (!entry.storageKey) continue
        const localStorageKey = remapStorageKey(entry.storageKey, native.identities)
        const localEntry = await packageEntry(
          destinationRoot,
          localStorageKey,
          entry.kind,
          this.signal
        )
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
      }
      // Re-open derived evidence through the same native readers before publishing any authority.
      await validatePackageRecords(
        destinationRoot,
        {
          ...manifest,
          source: { ...manifest.source, projectId, sessionId },
          excludedFiles: manifest.excludedFiles.map((file) => ({
            ...file,
            storageKey: remapStorageKey(file.storageKey, native.identities)
          })),
          inventory: nativeInventory
        },
        native.records,
        this.signal,
        manifest.source
      )
      onProgress?.({ phase: 'importing' })
      await rename(sourceRoot, join(evidenceDirectory, 'source'))
      await writeDurableJsonFile(
        join(evidenceDirectory, 'receipt.json'),
        JSON.stringify({
          schemaVersion: 1,
          ...session.packageOrigin,
          projectId,
          sessionId,
          identities: native.identities,
          files
        })
      )
      const directories: ImportJournal['directories'] = []
      for (const scope of [
        'artifacts',
        'uploads',
        'notebooks',
        'execution-file-evidence'
      ] as const) {
        const staged = join(destinationRoot, scope, projectId)
        if (!(await lstat(staged).catch(() => undefined))) continue
        for (const child of await readdir(staged)) directories.push({ scope, sessionId: child })
      }
      journal = importJournalSchema.parse({ schemaVersion: 1, projectId, sessionId, directories })
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
          await ensureWorkingFileEvidenceProject(root, projectId)
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
        const client = await this.options.getClient()
        published = Boolean(
          await client.fileOriginSession.findUnique({
            where: { projectId_sessionId: { projectId, sessionId } }
          })
        )
      }
      if (published === false) {
        // Preserve validation/cancellation/transaction failure while exposing retryable cleanup.
        // Retry removes only this uncommitted import; it must never replay publication.
        return withPackageCleanup(
          async () => {
            throw error
          },
          async () => {
            if (journal) await this.removeUnpublished(journal, operationId)
            await cleanupStaging()
          }
        )
      }
    }
    // Publication failures retain the journal; after publication retry only staging removal.
    await this.finishPublishedImport(configOperationRoot, operationId)
    return withPackageCleanup(async () => ({ projectId, sessionId }), cleanupStaging)
  }

  // Call before catalog hydration. The imported origin row witnesses the native transaction.
  // Recovery removes only fresh Session directories carrying this operation's ownership marker.
  recover(options: { collectDeletedPackages?: boolean } = {}): Promise<void> {
    return this.serialize(async () => {
      await this.recoverNow()
      if (options.collectDeletedPackages) await this.deletion.recover(this.signal)
    })
  }

  private async recoverNow(): Promise<void> {
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
          const client = await this.options.getClient()
          const committed = await client.fileOriginSession.findUnique({
            where: {
              projectId_sessionId: { projectId: identity.projectId, sessionId: identity.sessionId }
            }
          })
          if (!committed) await this.removeUnpublished(identity, operation)
          else await this.finishPublishedImport(stage, operation)
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

  async readOrigin(request: SessionPackageRequest): Promise<{
    sourceManifest: SessionPackageManifest
    identities: Record<string, string>
    files: SessionPackageReceipt['files']
    history?: PackageHistory
    originSessionIds: string[]
  }> {
    const safe = sessionPackageRequestSchema.parse(request)
    const directory = join(
      this.options.storageRoot,
      'artifacts',
      safe.projectId,
      safe.sessionId,
      '.session-package'
    )
    const receipt = sessionPackageReceiptSchema.parse(
      await readPackageJson(join(directory, 'receipt.json'))
    )
    if (
      receipt.projectId !== safe.projectId ||
      receipt.sessionId !== safe.sessionId ||
      receipt.manifestChecksum !== (await fileChecksum(join(directory, 'source', 'manifest.json')))
    )
      throw new Error('Session package receipt integrity mismatch.')
    const sourceManifest = sessionPackageManifestSchema.parse(
      await readPackageJson(join(directory, 'source', 'manifest.json'))
    )
    if (
      sourceManifest.source.projectId !== receipt.sourceProjectId ||
      sourceManifest.source.sessionId !== receipt.sourceSessionId
    )
      throw new Error('Session package receipt source identity mismatch.')
    const recordsEntry = sourceManifest.inventory.find((entry) => entry.path === 'records.json')
    if (recordsEntry?.checksum !== (await fileChecksum(join(directory, 'source', 'records.json'))))
      throw new Error('Session package source records checksum mismatch.')
    const records = parseNativeRecords(
      await readPackageJson(join(directory, 'source', 'records.json'))
    )
    return {
      sourceManifest,
      identities: receipt.identities,
      files: receipt.files,
      history: records.history,
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
  }

  private async finishPublishedImport(operationRoot: string, operation: string): Promise<void> {
    const identity = importJournalSchema.parse(
      await readPackageJson(join(operationRoot, 'journal.json'))
    )
    const client = await this.options.getClient()
    const projected = await client.session.findUnique({ where: { id: identity.sessionId } })
    if (projected && projected.projectId !== identity.projectId)
      throw new Error('Import publication Session identity mismatch.')
    // A cleanup retry cannot revive a Session deleted after successful publication.
    if (projected?.deletedAtMs != null) return
    const repository = new SessionRepository(
      this.configRoot,
      {},
      new SessionProjectionRepository(this.options.getClient)
    )
    const current = await repository.loadSessionWithDiagnostics(
      identity.projectId,
      identity.sessionId,
      { mode: 'read-only' }
    )
    if (current.status === 'unreadable')
      throw new Error('Import publication Session cannot be read safely.')
    if (current.status === 'found') {
      if (current.session.packageOrigin?.importId !== operation)
        throw new Error('Import publication Session identity mismatch.')
      // Resume with live authority, preserving later preferences and completing any interrupted
      // JSON-to-SQLite projection through the repository that owns that publication.
      await repository.saveSession(current.session)
      return
    }
    const session = await new SessionRepository(join(operationRoot, 'session-stage')).loadSession(
      identity.projectId,
      identity.sessionId
    )
    if (!session || session.packageOrigin?.importId !== operation)
      throw new Error('Import publication Session is missing or invalid.')
    // Live Session authority appears only after native records commit. Recovery repeats the
    // same repository publication; it never republishes records or replaces another Session.
    await repository.saveSession(session)
    // Keep the directory claims after publication. Startup package deletion requires these exact
    // import identities before it can retire any native scope, including retained upstream scopes.
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
