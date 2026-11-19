import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { mkdir, open, readdir, rm } from 'node:fs/promises'
import {
  readFileWithinLimit,
  writeDurableJsonFile,
  defaultFileDurability
} from '@aipoch/durable-files'
import { z } from 'zod'
import { WebToolError } from './errors'

const snapshotSchema = z
  .object({
    version: z.literal(1),
    snapshotId: z.string().uuid(),
    owner: z.string().regex(/^[a-f0-9]{64}$/),
    invocationId: z.string().min(1).max(512),
    originalUrl: z.string().max(2048),
    finalUrl: z.string().max(2048),
    fetchedAt: z.string().datetime(),
    contentType: z.string().max(128),
    extractorVersion: z.string().max(128),
    extractionMethod: z.enum(['main_content', 'semantic_dom', 'plain_text']),
    extractionQuality: z.enum(['normal', 'degraded']),
    title: z.string().max(512).optional(),
    text: z.string().max(6 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()
export type WebSnapshot = z.infer<typeof snapshotSchema>
export const webTextHash = (text: string): string => createHash('sha256').update(text).digest('hex')
const ownerHash = (sessionId: string): string => webTextHash(sessionId)
export const WEB_CACHE_POLICY_VERSION = 'public-direct-v1'
export const WEB_CACHE_TTL_MS = 5 * 60_000
const commitSchema = z
  .object({
    version: z.literal(1),
    snapshotId: z.string().uuid(),
    owner: z.string().regex(/^[a-f0-9]{64}$/),
    bodyOwner: z.string().regex(/^[a-f0-9]{64}$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    extractorVersion: z.string().max(128),
    fetchedAt: z.string().datetime(),
    committedAt: z.string().datetime()
  })
  .strict()
const cacheSchema = z
  .object({
    version: z.literal(1),
    snapshotId: z.string().uuid(),
    fetchedAt: z.string().datetime(),
    extractorVersion: z.string().max(128),
    policy: z.string().max(128)
  })
  .strict()
const cursorSchema = z
  .object({
    v: z.literal(1),
    s: z.string().uuid(),
    x: z.string().max(128),
    h: z.string().regex(/^[a-f0-9]{64}$/),
    o: z
      .number()
      .int()
      .nonnegative()
      .max(6 * 1024 * 1024)
  })
  .strict()
export type WebSnapshotCursor = z.infer<typeof cursorSchema>
const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'
const bodyReferenceSchema = z
  .object({ bodyOwner: z.string().regex(/^[a-f0-9]{64}$/), snapshotId: z.string().uuid() })
  .strict()
const inheritanceSchema = z
  .object({
    version: z.literal(1),
    childScope: z.string().max(1024),
    parentScope: z.string().max(1024),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    references: z.array(commitSchema).max(10000)
  })
  .strict()
export type PendingWebInheritance = z.infer<typeof inheritanceSchema>
const deletionSchema = z
  .object({ version: z.literal(1), references: z.array(bodyReferenceSchema).max(10000) })
  .strict()
const ownershipOperations = new Map<string, Promise<unknown>>()
const scopeSchema = z.object({ version: z.literal(1), scope: z.string().max(1024) }).strict()
const stores = new Map<string, WebSnapshotStore>()
export const getWebSnapshotStore = (root: string): WebSnapshotStore => {
  const key = resolve(root)
  let store = stores.get(key)
  if (!store) {
    store = new WebSnapshotStore(key)
    stores.set(key, store)
  }
  return store
}

/** Immutable session-owned evidence. Only a committed host receipt makes a snapshot replayable. */
export class WebSnapshotStore {
  private signingKey?: Promise<Buffer>
  constructor(private readonly root: string) {}

  private locked<T>(operation: () => Promise<T>): Promise<T> {
    const key = resolve(this.root)
    const previous = ownershipOperations.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    ownershipOperations.set(key, next)
    void next
      .finally(() => {
        if (ownershipOperations.get(key) === next) ownershipOperations.delete(key)
      })
      .catch(() => undefined)
    return next
  }

  private async assertActive(
    scope: string,
    code: 'INVALID_CURSOR' | 'EVIDENCE_UNAVAILABLE' = 'EVIDENCE_UNAVAILABLE'
  ): Promise<void> {
    const identities = [scope]
    try {
      const identity: unknown = JSON.parse(scope)
      if (
        Array.isArray(identity) &&
        identity.length === 3 &&
        identity.every((part) => typeof part === 'string')
      )
        identities.push(JSON.stringify(identity.slice(0, 2)))
    } catch {
      /* Non-JSON legacy scopes retain their own owner boundary. */
    }
    for (const identity of identities) {
      try {
        await readFileWithinLimit(
          join(this.root, ownerHash(identity), 'deleted.json'),
          4 * 1024 * 1024
        )
      } catch (error) {
        if (isMissing(error)) continue
        throw new WebToolError(code)
      }
      throw new WebToolError(code)
    }
  }

  private async recordScope(scope: string): Promise<void> {
    const directory = join(this.root, ownerHash(scope))
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await defaultFileDurability.syncDirectory(dirname(this.root))
    await defaultFileDurability.syncDirectory(this.root)
    const path = join(directory, 'scope.json')
    try {
      if (scopeSchema.parse(JSON.parse(await readFileWithinLimit(path, 2048))).scope !== scope)
        throw new WebToolError('EVIDENCE_UNAVAILABLE')
    } catch (error) {
      if (!isMissing(error)) throw error
      await writeDurableJsonFile(path, JSON.stringify({ version: 1, scope }))
    }
  }

  async write(
    sessionId: string,
    input: Omit<WebSnapshot, 'version' | 'snapshotId' | 'owner' | 'sha256'>,
    signal: AbortSignal
  ): Promise<WebSnapshot> {
    return this.locked(() => this.writeUnlocked(sessionId, input, signal))
  }

  async assertAvailable(scope: string): Promise<void> {
    return this.locked(() => this.assertActive(scope))
  }

  private async writeUnlocked(
    sessionId: string,
    input: Omit<WebSnapshot, 'version' | 'snapshotId' | 'owner' | 'sha256'>,
    signal: AbortSignal
  ): Promise<WebSnapshot> {
    await this.assertActive(sessionId)
    signal.throwIfAborted()
    const snapshot = snapshotSchema.parse({
      ...input,
      version: 1,
      snapshotId: randomUUID(),
      owner: ownerHash(sessionId),
      sha256: webTextHash(input.text)
    })
    // Persist directory entries as well as file content before the caller may commit its receipt.
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await defaultFileDurability.syncDirectory(dirname(this.root))
    const ownerDirectory = join(this.root, snapshot.owner)
    await mkdir(ownerDirectory, { recursive: true, mode: 0o700 })
    await this.recordScope(sessionId)
    await defaultFileDurability.syncDirectory(this.root)
    signal.throwIfAborted()
    await writeDurableJsonFile(
      join(ownerDirectory, `${snapshot.snapshotId}.json`),
      JSON.stringify(snapshot)
    )
    signal.throwIfAborted()
    return snapshot
  }

  async read(sessionId: string, snapshotId: string): Promise<WebSnapshot> {
    await this.assertActive(sessionId)
    return this.readBody(ownerHash(sessionId), snapshotId)
  }

  private async readBody(owner: string, snapshotId: string): Promise<WebSnapshot> {
    if (!z.string().uuid().safeParse(snapshotId).success)
      throw new WebToolError('EVIDENCE_UNAVAILABLE')
    try {
      // Read only the primary file: an interrupted temporary write is never committed evidence.
      const text = await readFileWithinLimit(
        join(this.root, owner, `${snapshotId}.json`),
        40 * 1024 * 1024
      )
      const value = snapshotSchema.parse(JSON.parse(text))
      if (
        value.owner !== owner ||
        value.snapshotId !== snapshotId ||
        webTextHash(value.text) !== value.sha256
      ) {
        throw new WebToolError('EVIDENCE_UNAVAILABLE')
      }
      return value
    } catch {
      throw new WebToolError('EVIDENCE_UNAVAILABLE')
    }
  }

  private commitPath(sessionId: string, snapshotId: string): string {
    return join(this.root, ownerHash(sessionId), 'committed', `${snapshotId}.json`)
  }

  /** Only this host callback, after its durable receipt, grants cache/continuation access. */
  async commit(
    sessionId: string,
    snapshotId: string,
    authorize?: () => Promise<boolean>
  ): Promise<void> {
    return this.locked(() => this.commitUnlocked(sessionId, snapshotId, authorize))
  }

  private async commitUnlocked(
    sessionId: string,
    snapshotId: string,
    authorize?: () => Promise<boolean>
  ): Promise<void> {
    await this.assertActive(sessionId)
    let snapshot: WebSnapshot
    let alreadyCommitted = true
    try {
      snapshot = await this.readCommittedUnlocked(sessionId, snapshotId)
    } catch (error) {
      if (!(error instanceof WebToolError) || error.code !== 'INVALID_CURSOR') throw error
      alreadyCommitted = false
      snapshot = await this.read(sessionId, snapshotId)
    }
    const key = this.cachePath(sessionId, snapshot.originalUrl, snapshot.extractorVersion)
    const existing = await this.readCacheEntry(key)
    // Re-reading old evidence never elects it as the URL's current cache, including when
    // two independent fetches have exactly the same millisecond timestamp.
    const publish =
      !existing ||
      existing.snapshotId === snapshotId ||
      (!alreadyCommitted && Date.parse(existing.fetchedAt) <= Date.parse(snapshot.fetchedAt))
    if (authorize && !(await authorize())) return
    if (publish) await this.writeCacheEntry(key, snapshotId, snapshot)
    if (!alreadyCommitted) {
      const directory = join(this.root, ownerHash(sessionId), 'committed')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await defaultFileDurability.syncDirectory(dirname(directory))
      // The cache pointer is published first. If the process stops before this marker,
      // reads fail closed and the completed receipt can idempotently finish this commit.
      await writeDurableJsonFile(
        this.commitPath(sessionId, snapshotId),
        JSON.stringify({
          version: 1,
          snapshotId,
          owner: ownerHash(sessionId),
          bodyOwner: snapshot.owner,
          sha256: snapshot.sha256,
          extractorVersion: snapshot.extractorVersion,
          fetchedAt: snapshot.fetchedAt,
          committedAt: new Date().toISOString()
        })
      )
    }
  }

  async readCommitted(sessionId: string, snapshotId: string): Promise<WebSnapshot> {
    return this.locked(() => this.readCommittedUnlocked(sessionId, snapshotId))
  }

  private async readCommittedUnlocked(sessionId: string, snapshotId: string): Promise<WebSnapshot> {
    const reference = await this.readReferenceUnlocked(sessionId, snapshotId)
    const snapshot = await this.readBody(reference.bodyOwner, snapshotId)
    if (
      reference.sha256 !== snapshot.sha256 ||
      reference.extractorVersion !== snapshot.extractorVersion ||
      reference.fetchedAt !== snapshot.fetchedAt
    )
      throw new WebToolError('EVIDENCE_UNAVAILABLE')
    return snapshot
  }

  private async readReferenceUnlocked(
    sessionId: string,
    snapshotId: string
  ): Promise<z.infer<typeof commitSchema>> {
    await this.assertActive(sessionId, 'INVALID_CURSOR')
    if (!z.string().uuid().safeParse(snapshotId).success) throw new WebToolError('INVALID_CURSOR')
    let reference: z.infer<typeof commitSchema>
    try {
      reference = commitSchema.parse(
        JSON.parse(await readFileWithinLimit(this.commitPath(sessionId, snapshotId), 4096))
      )
    } catch (error) {
      throw new WebToolError(isMissing(error) ? 'INVALID_CURSOR' : 'EVIDENCE_UNAVAILABLE')
    }
    if (reference.owner !== ownerHash(sessionId) || reference.snapshotId !== snapshotId)
      throw new WebToolError('INVALID_CURSOR')
    return reference
  }

  private cachePath(sessionId: string, url: string, version: string): string {
    return join(
      this.root,
      ownerHash(sessionId),
      'cache',
      `${webTextHash(JSON.stringify([url, version, WEB_CACHE_POLICY_VERSION]))}.json`
    )
  }

  private async readCacheEntry(path: string): Promise<z.infer<typeof cacheSchema> | undefined> {
    try {
      return cacheSchema.parse(JSON.parse(await readFileWithinLimit(path, 4096)))
    } catch (error) {
      if (isMissing(error)) return undefined
      throw new WebToolError('EVIDENCE_UNAVAILABLE')
    }
  }

  private async writeCacheEntry(
    path: string,
    snapshotId: string,
    snapshot: WebSnapshot
  ): Promise<void> {
    const directory = dirname(path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await defaultFileDurability.syncDirectory(dirname(directory))
    await writeDurableJsonFile(
      path,
      JSON.stringify({
        version: 1,
        snapshotId,
        fetchedAt: snapshot.fetchedAt,
        extractorVersion: snapshot.extractorVersion,
        policy: WEB_CACHE_POLICY_VERSION
      })
    )
  }

  async findCached(
    sessionId: string,
    url: string,
    version: string,
    now = Date.now()
  ): Promise<WebSnapshot | undefined> {
    const cached = await this.readCacheEntry(this.cachePath(sessionId, url, version))
    if (!cached) return undefined
    const age = now - Date.parse(cached.fetchedAt)
    if (age < 0 || age >= WEB_CACHE_TTL_MS) return undefined
    if (cached.policy !== WEB_CACHE_POLICY_VERSION || cached.extractorVersion !== version)
      throw new WebToolError('EVIDENCE_UNAVAILABLE')
    let snapshot: WebSnapshot
    try {
      snapshot = await this.readCommitted(sessionId, cached.snapshotId)
    } catch {
      throw new WebToolError('EVIDENCE_UNAVAILABLE')
    }
    if (
      snapshot.originalUrl !== url ||
      snapshot.extractorVersion !== version ||
      snapshot.fetchedAt !== cached.fetchedAt
    )
      throw new WebToolError('EVIDENCE_UNAVAILABLE')
    return snapshot
  }

  async prepareInheritance(
    parentScope: string,
    childScope: string,
    snapshotIds: readonly string[],
    fingerprint: string,
    legacyParentScope?: string
  ): Promise<void> {
    return this.locked(async () => {
      await this.assertActive(parentScope)
      await this.assertActive(childScope)
      if (parentScope === childScope) throw new WebToolError('INVALID_CURSOR')
      const references: z.infer<typeof commitSchema>[] = []
      for (const snapshotId of new Set(snapshotIds)) {
        let sourceScope = parentScope
        let source: z.infer<typeof commitSchema>
        try {
          source = await this.readReferenceUnlocked(sourceScope, snapshotId)
        } catch (error) {
          if (
            !legacyParentScope ||
            !(error instanceof WebToolError) ||
            error.code !== 'INVALID_CURSOR'
          )
            throw error
          sourceScope = legacyParentScope
          source = await this.readReferenceUnlocked(sourceScope, snapshotId)
        }
        references.push({ ...source, owner: ownerHash(childScope) })
      }
      const intent = inheritanceSchema.parse({
        version: 1,
        childScope,
        parentScope,
        fingerprint,
        references
      })
      const directory = join(this.root, ownerHash(childScope))
      await this.recordScope(childScope)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await defaultFileDurability.syncDirectory(this.root)
      const path = join(directory, 'inheritance.json')
      try {
        const existing = inheritanceSchema.parse(
          JSON.parse(await readFileWithinLimit(path, 4 * 1024 * 1024))
        )
        if (JSON.stringify(existing) !== JSON.stringify(intent))
          throw new WebToolError('EVIDENCE_UNAVAILABLE')
        return
      } catch (error) {
        if (!isMissing(error)) throw error
      }
      // Prepared references retain bodies against parent deletion without granting child access.
      await writeDurableJsonFile(path, JSON.stringify(intent))
    })
  }

  async finishInheritance(childScope: string, fingerprint: string): Promise<void> {
    return this.locked(async () => {
      await this.assertActive(childScope)
      const path = join(this.root, ownerHash(childScope), 'inheritance.json')
      const intent = inheritanceSchema.parse(
        JSON.parse(await readFileWithinLimit(path, 4 * 1024 * 1024))
      )
      if (intent.childScope !== childScope || intent.fingerprint !== fingerprint)
        throw new WebToolError('EVIDENCE_UNAVAILABLE')
      for (const reference of intent.references) {
        let snapshot: WebSnapshot | undefined
        try {
          snapshot = await this.readBody(reference.bodyOwner, reference.snapshotId)
          if (
            reference.sha256 !== snapshot.sha256 ||
            reference.extractorVersion !== snapshot.extractorVersion
          )
            snapshot = undefined
        } catch (error) {
          if (!(error instanceof WebToolError) || error.code !== 'EVIDENCE_UNAVAILABLE') throw error
        }
        // Preserve an unavailable historical reference without letting its missing bytes block
        // unrelated new work. Reading this snapshot still validates the original canonical hash.
        if (snapshot) {
          const cachePath = this.cachePath(
            childScope,
            snapshot.originalUrl,
            snapshot.extractorVersion
          )
          const existing = await this.readCacheEntry(cachePath)
          if (!existing || Date.parse(existing.fetchedAt) < Date.parse(snapshot.fetchedAt))
            await this.writeCacheEntry(cachePath, snapshot.snapshotId, snapshot)
        }
        const marker = this.commitPath(childScope, reference.snapshotId)
        await mkdir(dirname(marker), { recursive: true, mode: 0o700 })
        await defaultFileDurability.syncDirectory(dirname(dirname(marker)))
        await writeDurableJsonFile(marker, JSON.stringify(reference))
      }
      await rm(path)
      await defaultFileDurability.syncDirectory(dirname(path))
    })
  }

  async abortInheritance(childScope: string, fingerprint: string): Promise<void> {
    return this.locked(async () => {
      const path = join(this.root, ownerHash(childScope), 'inheritance.json')
      let intent: PendingWebInheritance
      try {
        intent = inheritanceSchema.parse(
          JSON.parse(await readFileWithinLimit(path, 4 * 1024 * 1024))
        )
      } catch (error) {
        if (isMissing(error)) return
        throw new WebToolError('EVIDENCE_UNAVAILABLE')
      }
      if (intent.childScope !== childScope || intent.fingerprint !== fingerprint)
        throw new WebToolError('EVIDENCE_UNAVAILABLE')
      await rm(path)
      await defaultFileDurability.syncDirectory(dirname(path))
      await this.collectUnreferenced(intent.references)
    })
  }

  async pendingInheritances(scopes?: readonly string[]): Promise<PendingWebInheritance[]> {
    return this.locked(async () => {
      const pending: PendingWebInheritance[] = []
      for (const owner of scopes
        ? [...new Set(scopes.map(ownerHash))]
        : await this.ownerDirectories()) {
        try {
          const intent = inheritanceSchema.parse(
            JSON.parse(
              await readFileWithinLimit(join(this.root, owner, 'inheritance.json'), 4 * 1024 * 1024)
            )
          )
          if (ownerHash(intent.childScope) !== owner) throw new WebToolError('EVIDENCE_UNAVAILABLE')
          pending.push(intent)
        } catch (error) {
          if (!isMissing(error)) throw new WebToolError('EVIDENCE_UNAVAILABLE')
        }
      }
      return pending
    })
  }

  async releaseSession(scope: string): Promise<void> {
    return this.locked(() => this.releaseSessionUnlocked(scope))
  }

  private async releaseSessionUnlocked(scope: string): Promise<void> {
    const owner = ownerHash(scope)
    const directory = join(this.root, owner)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await this.recordScope(scope)
    await defaultFileDurability.syncDirectory(this.root)
    const tombstone = join(directory, 'deleted.json')
    let deletion: z.infer<typeof deletionSchema>
    try {
      deletion = deletionSchema.parse(
        JSON.parse(await readFileWithinLimit(tombstone, 4 * 1024 * 1024))
      )
    } catch (error) {
      if (!isMissing(error)) throw new WebToolError('EVIDENCE_UNAVAILABLE')
      const references: z.infer<typeof bodyReferenceSchema>[] = []
      for (const file of await readdir(directory)) {
        if (z.string().uuid().safeParse(file.slice(0, -5)).success && file.endsWith('.json'))
          references.push({ bodyOwner: owner, snapshotId: file.slice(0, -5) })
      }
      for (const reference of await this.ownerReferences(owner)) references.push(reference)
      deletion = deletionSchema.parse({ version: 1, references })
      await writeDurableJsonFile(tombstone, JSON.stringify(deletion))
    }
    await this.completeRelease(owner, deletion.references)
  }

  async hasCommittedReference(scope: string, snapshotId: string): Promise<boolean> {
    return this.locked(async () => {
      await this.assertActive(scope, 'INVALID_CURSOR')
      if (!z.string().uuid().safeParse(snapshotId).success) return false
      try {
        const reference = commitSchema.parse(
          JSON.parse(await readFileWithinLimit(this.commitPath(scope, snapshotId), 4096))
        )
        if (reference.owner !== ownerHash(scope) || reference.snapshotId !== snapshotId)
          throw new WebToolError('EVIDENCE_UNAVAILABLE')
        return true
      } catch (error) {
        if (isMissing(error)) return false
        throw error
      }
    })
  }

  async releaseSessionTree(projectId: string, sessionId: string): Promise<void> {
    return this.locked(() => this.releaseSessionTreeUnlocked(projectId, sessionId))
  }

  private async releaseSessionTreeUnlocked(projectId: string, sessionId: string): Promise<void> {
    await this.releaseSessionUnlocked(JSON.stringify([projectId, sessionId]))
    for (const owner of await this.ownerDirectories()) {
      let saved: z.infer<typeof scopeSchema>
      try {
        saved = scopeSchema.parse(
          JSON.parse(await readFileWithinLimit(join(this.root, owner, 'scope.json'), 2048))
        )
      } catch (error) {
        if (isMissing(error)) continue
        throw error
      }
      if (ownerHash(saved.scope) !== owner) throw new WebToolError('EVIDENCE_UNAVAILABLE')
      let identity: unknown
      try {
        identity = JSON.parse(saved.scope)
      } catch {
        continue
      }
      if (
        Array.isArray(identity) &&
        identity.length === 3 &&
        identity[0] === projectId &&
        identity[1] === sessionId
      )
        await this.releaseSessionUnlocked(saved.scope)
    }
  }

  async recoverDeletions(): Promise<void> {
    return this.locked(async () => {
      for (const owner of await this.ownerDirectories()) {
        let deletion: z.infer<typeof deletionSchema>
        try {
          deletion = deletionSchema.parse(
            JSON.parse(
              await readFileWithinLimit(join(this.root, owner, 'deleted.json'), 4 * 1024 * 1024)
            )
          )
        } catch (error) {
          if (isMissing(error)) continue
          throw new WebToolError('EVIDENCE_UNAVAILABLE')
        }
        await this.completeRelease(owner, deletion.references)
        try {
          const scope = scopeSchema.parse(
            JSON.parse(await readFileWithinLimit(join(this.root, owner, 'scope.json'), 2048))
          )
          const identity: unknown = JSON.parse(scope.scope)
          if (
            Array.isArray(identity) &&
            identity.length === 2 &&
            identity.every((part) => typeof part === 'string')
          )
            await this.releaseSessionTreeUnlocked(identity[0], identity[1])
        } catch (error) {
          if (!isMissing(error)) throw new WebToolError('EVIDENCE_UNAVAILABLE')
        }
      }
    })
  }

  async deletedSessions(): Promise<Array<{ projectId: string; sessionId: string }>> {
    return this.locked(async () => {
      const bindings: Array<{ projectId: string; sessionId: string }> = []
      for (const owner of await this.ownerDirectories()) {
        try {
          deletionSchema.parse(
            JSON.parse(
              await readFileWithinLimit(join(this.root, owner, 'deleted.json'), 4 * 1024 * 1024)
            )
          )
          const saved = scopeSchema.parse(
            JSON.parse(await readFileWithinLimit(join(this.root, owner, 'scope.json'), 2048))
          )
          if (ownerHash(saved.scope) !== owner) throw new WebToolError('EVIDENCE_UNAVAILABLE')
          const identity: unknown = JSON.parse(saved.scope)
          if (
            Array.isArray(identity) &&
            identity.length === 2 &&
            identity.every((part) => typeof part === 'string')
          )
            bindings.push({ projectId: identity[0], sessionId: identity[1] })
        } catch (error) {
          if (!isMissing(error)) throw new WebToolError('EVIDENCE_UNAVAILABLE')
        }
      }
      return bindings
    })
  }

  async ownedSessions(): Promise<Array<{ projectId: string; sessionId: string }>> {
    return this.locked(async () => {
      const bindings = new Map<string, { projectId: string; sessionId: string }>()
      for (const owner of await this.ownerDirectories()) {
        let saved: z.infer<typeof scopeSchema>
        try {
          saved = scopeSchema.parse(
            JSON.parse(await readFileWithinLimit(join(this.root, owner, 'scope.json'), 2048))
          )
        } catch (error) {
          if (isMissing(error)) continue
          throw new WebToolError('EVIDENCE_UNAVAILABLE')
        }
        if (ownerHash(saved.scope) !== owner) throw new WebToolError('EVIDENCE_UNAVAILABLE')
        let identity: unknown
        try {
          identity = JSON.parse(saved.scope)
        } catch {
          continue
        }
        if (
          Array.isArray(identity) &&
          [2, 3].includes(identity.length) &&
          identity.every((part) => typeof part === 'string')
        )
          bindings.set(JSON.stringify(identity.slice(0, 2)), {
            projectId: identity[0],
            sessionId: identity[1]
          })
      }
      return [...bindings.values()]
    })
  }

  private async completeRelease(
    owner: string,
    references: Array<z.infer<typeof bodyReferenceSchema>>
  ): Promise<void> {
    const directory = join(this.root, owner)
    await rm(join(directory, 'committed'), { recursive: true, force: true })
    await rm(join(directory, 'cache'), { recursive: true, force: true })
    await rm(join(directory, 'inheritance.json'), { force: true })
    await defaultFileDurability.syncDirectory(directory)
    await this.collectUnreferenced(references)
  }

  private async ownerDirectories(): Promise<string[]> {
    try {
      return (await readdir(this.root, { withFileTypes: true }))
        .filter((item) => item.isDirectory() && /^[a-f0-9]{64}$/.test(item.name))
        .map((item) => item.name)
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
  }

  private async ownerReferences(
    owner: string
  ): Promise<Array<z.infer<typeof bodyReferenceSchema>>> {
    const references: Array<z.infer<typeof bodyReferenceSchema>> = []
    const directory = join(this.root, owner)
    let files: string[] = []
    try {
      files = await readdir(join(directory, 'committed'))
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    for (const file of files) {
      if (file.endsWith('.tmp')) continue
      if (!file.endsWith('.json') || !z.string().uuid().safeParse(file.slice(0, -5)).success)
        throw new WebToolError('EVIDENCE_UNAVAILABLE')
      const reference = commitSchema.parse(
        JSON.parse(await readFileWithinLimit(join(directory, 'committed', file), 4096))
      )
      if (reference.owner !== owner || reference.snapshotId !== file.slice(0, -5))
        throw new WebToolError('EVIDENCE_UNAVAILABLE')
      references.push({ bodyOwner: reference.bodyOwner, snapshotId: reference.snapshotId })
    }
    try {
      const pending = inheritanceSchema.parse(
        JSON.parse(await readFileWithinLimit(join(directory, 'inheritance.json'), 4 * 1024 * 1024))
      )
      if (ownerHash(pending.childScope) !== owner) throw new WebToolError('EVIDENCE_UNAVAILABLE')
      references.push(
        ...pending.references.map((reference) => ({
          bodyOwner: reference.bodyOwner,
          snapshotId: reference.snapshotId
        }))
      )
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    return references
  }

  private async collectUnreferenced(
    candidates: ReadonlyArray<z.infer<typeof bodyReferenceSchema>>
  ): Promise<void> {
    const retained = new Set<string>()
    for (const owner of await this.ownerDirectories()) {
      try {
        deletionSchema.parse(
          JSON.parse(
            await readFileWithinLimit(join(this.root, owner, 'deleted.json'), 4 * 1024 * 1024)
          )
        )
        continue
      } catch (error) {
        if (!isMissing(error)) throw new WebToolError('EVIDENCE_UNAVAILABLE')
      }
      for (const reference of await this.ownerReferences(owner))
        retained.add(`${reference.bodyOwner}/${reference.snapshotId}`)
    }
    for (const candidate of candidates) {
      if (retained.has(`${candidate.bodyOwner}/${candidate.snapshotId}`)) continue
      const path = join(this.root, candidate.bodyOwner, `${candidate.snapshotId}.json`)
      await rm(path, { force: true })
      await defaultFileDurability.syncDirectory(dirname(path))
    }
  }

  private key(): Promise<Buffer> {
    if (!this.signingKey)
      this.signingKey = (async () => {
        await mkdir(this.root, { recursive: true, mode: 0o700 })
        await defaultFileDurability.syncDirectory(dirname(this.root))
        const path = join(this.root, 'cursor-key')
        try {
          const file = await open(path, 'wx', 0o600)
          try {
            await file.writeFile(randomBytes(32).toString('hex'))
            await file.sync()
          } finally {
            await file.close()
          }
          await defaultFileDurability.syncDirectory(this.root)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
            throw new WebToolError('EVIDENCE_UNAVAILABLE')
        }
        const hex = await readFileWithinLimit(path, 64)
        if (!/^[a-f0-9]{64}$/.test(hex)) throw new WebToolError('EVIDENCE_UNAVAILABLE')
        return Buffer.from(hex, 'hex')
      })()
    return this.signingKey
  }

  async createCursor(snapshot: WebSnapshot, offset: number): Promise<string> {
    const payload = cursorSchema.parse({
      v: 1,
      s: snapshot.snapshotId,
      x: snapshot.extractorVersion,
      h: snapshot.sha256,
      o: offset
    })
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return `${encoded}.${createHmac('sha256', await this.key())
      .update(encoded)
      .digest('base64url')}`
  }

  async parseCursor(snapshotId: string, cursor: string): Promise<WebSnapshotCursor> {
    const [encoded, signature, extra] = cursor.split('.')
    if (
      !encoded ||
      !signature ||
      extra ||
      !/^[A-Za-z0-9_-]+$/.test(encoded) ||
      !/^[A-Za-z0-9_-]{43}$/.test(signature)
    )
      throw new WebToolError('INVALID_CURSOR')
    const expected = createHmac('sha256', await this.key())
      .update(encoded)
      .digest()
    const supplied = Buffer.from(signature, 'base64url')
    if (
      supplied.length !== expected.length ||
      supplied.toString('base64url') !== signature ||
      !timingSafeEqual(supplied, expected)
    )
      throw new WebToolError('INVALID_CURSOR')
    try {
      const value = cursorSchema.parse(
        JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
      )
      if (value.s !== snapshotId) throw new WebToolError('INVALID_CURSOR')
      return value
    } catch {
      throw new WebToolError('INVALID_CURSOR')
    }
  }
}
