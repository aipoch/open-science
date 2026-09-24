import {
  AutomaticClassificationPausedError,
  type AutomaticClassificationPauseReason
} from '../../shared/classification'
import { saveSmartRuleVersion } from './smart-rule-history'
import { readSmartRunProgress } from './smart-run-progress'
import type { ClassificationUsageContext } from '../../shared/classification'
import {
  smartRulePrompt,
  formatSmartRule,
  parseSmartRule,
  serializedSmartRuleSchema
} from '../../shared/smart-collection-rule'
import { smartInput, readSmartEvidence, type ReadSmartEvidence } from './smart-evidence'
import {
  ClassificationEvaluationError,
  classificationFailureCategories
} from '../../shared/classification'
import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import { z } from 'zod'
import type { ClassifyLiterature, ClassificationSnapshot } from '../../shared/classification'
import {
  LITERATURE_COLLECTION_NAME_CONFLICT,
  type LiteratureCatalogReceipt
} from '../../shared/literature'
import {
  type SmartCollectionCommand,
  type SmartCollectionPreview,
  type SmartCollectionView,
  type SmartScope,
  smartEvidenceSchema,
  smartEvidenceModeSchema,
  type SmartEvidenceMode,
  type SmartEvidence,
  smartScopeSchema,
  smartRunSnapshotSchema,
  SMART_COLLECTION_RESUME_UNAVAILABLE
} from '../../shared/literature-smart-collections'
import { acquireDataRootWriter } from '../storage/migration-state'

const checkpointSchema = z.array(
  z.object({
    id: z.string(),
    digest: z.string(),
    state: z.enum(['pending', 'done', 'error']),
    failure: z.enum(classificationFailureCategories).optional(),
    deferred: z.boolean().optional()
  })
)
const savedResultSchema = z.object({
  answer: z.object({
    verdict: z.enum(['match', 'no-match', 'uncertain']),
    model: z.string(),
    probabilities: z.record(z.string(), z.number())
  })
})
type Checkpoint = z.infer<typeof checkpointSchema>
type Client = PrismaClient | Prisma.TransactionClient

function matchesDecisionSource(
  row: { decisionSource?: 'ai' | 'manual' },
  source: 'all' | 'ai' | 'manual'
): boolean {
  return source === 'all' || row.decisionSource === source
}

/** Owns rules, assessments, overrides and resumable work; never writes ordinary memberships. */
export class LiteratureSmartCollections {
  private readonly active = new Map<string, AbortController>()
  private readonly deleting = new Set<string>()
  private readonly work = new Map<string, Promise<void>>()
  private readonly previews = new Map<string, AbortController>()
  private queue: Promise<void> = Promise.resolve()
  private readonly previewWork = new Set<Promise<unknown>>()
  private inferenceActive = 0
  private readonly inferenceWaiters: Array<() => void> = []

  private async classify(input: Parameters<ClassifyLiterature>[0]): ReturnType<ClassifyLiterature> {
    if (this.inferenceActive >= 4) {
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => {
          const index = this.inferenceWaiters.indexOf(ready)
          if (index >= 0) this.inferenceWaiters.splice(index, 1)
          reject(input.signal?.reason)
        }
        const ready = (): void => {
          input.signal?.removeEventListener('abort', abort)
          resolve()
        }
        input.signal?.throwIfAborted()
        this.inferenceWaiters.push(ready)
        input.signal?.addEventListener('abort', abort, { once: true })
      })
    } else this.inferenceActive++
    try {
      input.signal?.throwIfAborted()
      return await this.classifier.classifyLiterature(input)
    } finally {
      const next = this.inferenceWaiters.shift()
      // Transfer the occupied slot to the waiter; only an unused slot reduces the count.
      if (next) next()
      else this.inferenceActive--
    }
  }

  constructor(
    private readonly getClient: () => Promise<PrismaClient>,
    private readonly classifier: {
      subscribe?: (listener: () => void) => () => void
      snapshot: () => Promise<ClassificationSnapshot>
      classifyLiterature: ClassifyLiterature
    },
    private readonly onChanged: (id: string) => void,
    private readonly readEvidence?: ReadSmartEvidence
  ) {}

  private automaticTimer?: ReturnType<typeof setTimeout>
  private automaticWork: Promise<void> = Promise.resolve()
  private automaticDirty = false
  private disposed = false
  private unsubscribeClassification?: () => void

  start(): void {
    if (this.disposed || this.unsubscribeClassification) return
    this.unsubscribeClassification =
      this.classifier.subscribe?.(() => this.schedule()) ?? (() => undefined)
    this.schedule()
  }

  schedule(): void {
    this.reads.clear()
    if (this.disposed) return
    this.automaticDirty = true
    clearTimeout(this.automaticTimer)
    this.automaticTimer = setTimeout(() => {
      this.automaticWork = this.automaticWork
        .catch(() => undefined)
        .then(async () => {
          if (this.disposed || !this.automaticDirty) return
          this.automaticDirty = false
          const client = await this.getClient()
          if (!(await this.policy()).configured) return
          const collections = await client.literatureSmartCollection.findMany({
            where: { autoUpdate: true }
          })
          for (const { collectionId, automaticPauseReason } of collections) {
            if (this.disposed) return
            if (this.active.has(collectionId)) {
              this.automaticDirty = true
              continue
            }
            if (automaticPauseReason) continue
            try {
              await this.execute(
                { kind: 'smart-collection', collectionId, action: 'refresh', offset: 0 },
                true
              )
            } catch {
              /* User can inspect unavailable scopes/configuration and retry explicitly. */
            }
          }
        })
      void this.automaticWork.catch(() => undefined)
    }, 750)
  }

  private changed(id: string): void {
    this.reads.clear()
    try {
      this.onChanged(id)
    } catch {
      /* Event delivery cannot undo committed work. */
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true
    this.unsubscribeClassification?.()
    this.scopeReads.clear()
    clearTimeout(this.automaticTimer)
    await this.automaticWork.catch(() => undefined)
    for (const controller of [...this.active.values(), ...this.previews.values()])
      controller.abort()
    await Promise.allSettled([this.queue, ...this.previewWork])
  }
  async deleteCollection<T>(collectionId: string, remove: () => Promise<T>): Promise<T> {
    this.deleting.add(collectionId)
    try {
      this.active.get(collectionId)?.abort()
      await this.work.get(collectionId)
      return await remove()
    } finally {
      this.deleting.delete(collectionId)
    }
  }
  async ruleUpdated(collectionId: string): Promise<void> {
    this.reads.clear()
    this.scopeReads.clear()
    const client = await this.getClient()
    const current = await client.literatureSmartCollection.findUnique({ where: { collectionId } })
    if (!current) return
    const outdated = await client.literatureSmartRun.findFirst({
      where: {
        collectionId,
        state: { in: ['queued', 'running'] },
        ruleRevision: { not: current.ruleRevision }
      }
    })
    if (outdated) this.active.get(collectionId)?.abort()
    if (current.autoUpdate) this.schedule()
  }
  private async checkpoint(client: Client, runId: string, unfinished = false): Promise<Checkpoint> {
    const rows = await client.literatureSmartRunItem.findMany({
      where: { runId, ...(unfinished ? { state: { not: 'done' } } : {}) },
      select: { itemId: true, digest: true, state: true, failure: true, deferred: true },
      orderBy: { itemId: 'asc' }
    })
    return checkpointSchema.parse(
      rows.map((row) => ({
        id: row.itemId,
        digest: row.digest,
        state: row.state,
        ...(row.failure ? { failure: row.failure } : {}),
        deferred: row.deferred
      }))
    )
  }
  async policy(): Promise<{ key: string; configured: boolean }> {
    const snapshot = await this.classifier.snapshot()
    const binding = snapshot.smartCollections
    const service = snapshot.services.find((entry) => entry.id === binding?.serviceId)
    return {
      key: JSON.stringify([
        binding?.serviceId,
        binding?.modelId,
        service?.adapter,
        service?.baseUrl,
        'literature-choice-v1'
      ]),
      configured: Boolean(binding && service?.configured)
    }
  }
  async scope(
    client: Client,
    scope: SmartScope
  ): Promise<Prisma.LiteratureItemWhereInput | undefined> {
    const available = { deletedAt: null, mergedIntoItemId: null }
    if (scope.kind === 'library') return available
    if (scope.kind === 'collection') {
      const source = await client.literatureCollection.findUnique({
        where: { id: scope.id },
        include: { smart: true }
      })
      if (!source || source.smart) return undefined
      return { ...available, collections: { some: { collectionId: scope.id } } }
    }
    const project = await client.project.findFirst({ where: { id: scope.id, deletedAt: null } })
    if (!project || (await client.projectDeletionIntent.count({ where: { projectId: scope.id } })))
      return undefined
    return { ...available, projects: { some: { projectId: scope.id } } }
  }
  private async definition(
    client: Client,
    id: string
  ): Promise<{
    definition: Prisma.LiteratureSmartCollectionGetPayload<{ include: { collection: true } }>
    scope: SmartScope
    where: Prisma.LiteratureItemWhereInput | undefined
  }> {
    const definition = await client.literatureSmartCollection.findUnique({
      where: { collectionId: id },
      include: { collection: true }
    })
    if (!definition) throw new Error('Smart collection is unavailable.')
    const scope = smartScopeSchema.parse({
      kind: definition.scopeKind,
      ...(definition.scopeId ? { id: definition.scopeId } : {})
    })
    return { definition, scope, where: await this.scope(client, scope) }
  }
  private readonly reads = new Map<
    string,
    Promise<Awaited<ReturnType<LiteratureSmartCollections['scanRows']>>>
  >()

  // Metadata scans share one SQLite connection. Temporary triggers track only relevant
  // local writes; data_version still catches all commits from external connections.
  private readonly scopeReads = new Map<
    string,
    Awaited<ReturnType<LiteratureSmartCollections['scanRows']>>
  >()
  private scopeReadClient?: Client
  private scopeVersionReady?: Promise<void>

  private async initializeScopeVersion(client: PrismaClient): Promise<void> {
    await client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'CREATE TEMP TABLE IF NOT EXISTS SmartScopeVersion (version INTEGER NOT NULL)'
      )
      await tx.$executeRawUnsafe(
        'INSERT INTO SmartScopeVersion SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM SmartScopeVersion)'
      )
      // Fixed application identifiers only; no user input is interpolated into SQL.
      for (const table of [
        'LiteratureItem',
        'LiteratureCollection',
        'LiteratureCollectionItem',
        'LiteratureSmartCollection',
        'LiteratureSmartAssessment',
        'LiteratureSmartOverride',
        'LiteratureSmartRun',
        'LiteratureSmartRunItem',
        'LiteratureAttachment',
        'LiteratureAttachmentVersion',
        'ProjectLiterature',
        'Project',
        'ProjectDeletionIntent'
      ]) {
        for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
          await tx.$executeRawUnsafe(`CREATE TEMP TRIGGER IF NOT EXISTS "SmartScope_${table}_${operation}"
            AFTER ${operation} ON main."${table}" BEGIN
            UPDATE SmartScopeVersion SET version = version + 1; END`)
        }
      }
    })
  }

  private async rows(
    id: string,
    client?: Client,
    itemIds?: string[],
    details = true,
    projectId?: string
  ): ReturnType<LiteratureSmartCollections['scanRows']> {
    const root = await this.getClient()
    if (client && client !== root) return this.scanRows(id, client, itemIds, details, projectId)
    const cacheable = !details && !itemIds && !projectId
    const version = async (): Promise<string> => {
      const [state] = await root.$queryRaw<{ changes: bigint; version: bigint }[]>`
        SELECT SmartScopeVersion.version AS changes, data_version AS version
        FROM temp.SmartScopeVersion, pragma_data_version
      `
      return `${state.changes}:${state.version}`
    }
    if (this.scopeReadClient !== root) {
      this.scopeReads.clear()
      this.scopeReadClient = root
      this.scopeVersionReady = this.initializeScopeVersion(root).catch((error) => {
        this.scopeReadClient = undefined
        throw error
      })
    }
    await this.scopeVersionReady
    const before = cacheable ? await version() : undefined
    const policy = await this.policy()
    const key = JSON.stringify([id, itemIds, details, projectId, policy, before])
    const cached = cacheable ? this.scopeReads.get(key) : undefined
    if (cached) {
      this.scopeReads.delete(key)
      this.scopeReads.set(key, cached)
      return cached
    }
    const pending = this.reads.get(key)
    if (pending) return pending
    const work = this.scanRows(id, root, itemIds, details, projectId)
    this.reads.set(key, work)
    try {
      const result = await work
      // Never retain a mixed snapshot if a write interleaved with the paged scan.
      if (
        cacheable &&
        !this.disposed &&
        result.rows.length <= 10_000 &&
        JSON.stringify(result.policy) === JSON.stringify(policy) &&
        before === (await version())
      ) {
        this.scopeReads.set(key, result)
        // At most four scopes / 10,000 metadata rows total; no abstracts or PDF text retained.
        let retained = [...this.scopeReads.values()].reduce(
          (sum, value) => sum + value.rows.length,
          0
        )
        while (this.scopeReads.size > 4 || retained > 10_000) {
          const oldest = this.scopeReads.keys().next().value!
          retained -= this.scopeReads.get(oldest)!.rows.length
          this.scopeReads.delete(oldest)
        }
      }
      return result
    } finally {
      if (this.reads.get(key) === work) this.reads.delete(key)
    }
  }

  private async scanRows(
    id: string,
    client?: Client,
    itemIds?: string[],
    details = true,
    projectId?: string
  ): Promise<
    Awaited<ReturnType<LiteratureSmartCollections['definition']>> & {
      rows: SmartCollectionView['rows']
      checkpoint: Checkpoint
      digests: Map<string, string>
      policy: Awaited<ReturnType<LiteratureSmartCollections['policy']>>
    }
  > {
    client ??= await this.getClient()
    const { definition, scope, where } = await this.definition(client, id)
    const policy = await this.policy()
    const rows: SmartCollectionView['rows'] = []
    const digests = new Map<string, string>()
    const lastRun = await client.literatureSmartRun.findFirst({
      where: { collectionId: id },
      orderBy: { createdAt: 'desc' }
    })
    const failures = new Map(
      lastRun?.ruleRevision === definition.ruleRevision && lastRun.policyKey === policy.key
        ? (await this.checkpoint(client, lastRun.id, true)).map((row) => [row.id, row])
        : []
    )
    const evidenceMode = smartEvidenceModeSchema.parse(definition.evidenceMode)
    let cursor: string | undefined
    // ponytail: freshness scans scope metadata in 200-record pages; add indexed input digests
    // if many large smart scopes make catalog reads too expensive. No abstracts are retained here.
    while (where) {
      const items = await client.literatureItem.findMany({
        where:
          itemIds || projectId
            ? {
                AND: [
                  where,
                  ...(itemIds ? [{ id: { in: itemIds } }] : []),
                  ...(projectId ? [{ projects: { some: { projectId } } }] : [])
                ]
              }
            : where,
        orderBy: { id: 'asc' },
        take: 200,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          title: true,
          abstract: true,
          smartAssessments: {
            where: { collectionId: id },
            select: {
              ruleRevision: true,
              inputDigest: true,
              policyKey: true,
              model: true,
              verdict: true,
              evaluatedAt: details,
              probabilitiesJson: details,
              evidenceJson: details
            }
          },
          smartOverrides: { where: { collectionId: id } }
        }
      })
      const ruleVersions = details
        ? new Map(
            (
              await client.literatureSmartRuleRevision.findMany({
                where: {
                  collectionId: id,
                  revision: {
                    in: [
                      ...new Set(
                        items.flatMap((item) =>
                          item.smartAssessments.map((assessment) => assessment.ruleRevision)
                        )
                      )
                    ]
                  }
                }
              })
            ).map((version) => [version.revision, version])
          )
        : new Map()
      const versions = new Map(
        evidenceMode === 'full-text' && items.length
          ? (
              await client.literatureItem.findMany({
                where: { id: { in: items.map((item) => item.id) } },
                select: {
                  id: true,
                  attachments: {
                    where: { kind: 'fullText' },
                    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
                    take: 1,
                    select: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } }
                  }
                }
              })
            ).map((item) => [item.id, item.attachments[0]?.versions[0]] as const)
          : []
      )
      for (const item of items) {
        const inputDigest = (
          await smartInput(client, item, evidenceMode, versions.get(item.id) ?? null)
        ).digest
        digests.set(item.id, inputDigest)
        const assessment = item.smartAssessments[0]
        const override = item.smartOverrides[0]?.decision as 'include' | 'exclude' | undefined
        const current =
          assessment &&
          assessment.ruleRevision === definition.ruleRevision &&
          assessment.inputDigest === inputDigest &&
          assessment.policyKey === policy.key
        const incomplete = failures.get(item.id)?.digest === inputDigest
        const failed = incomplete && failures.get(item.id)?.state === 'error'
        rows.push({
          collectionId: id,
          id: item.id,
          title: item.title,
          override,
          decisionSource: override
            ? 'manual'
            : assessment && assessment.model !== 'insufficient-evidence'
              ? 'ai'
              : undefined,
          failure: failed ? (failures.get(item.id)?.failure ?? 'unknown') : undefined,
          reason:
            assessment && !current
              ? assessment.ruleRevision !== definition.ruleRevision
                ? 'rule-changed'
                : assessment.inputDigest !== inputDigest
                  ? 'input-changed'
                  : 'model-changed'
              : assessment?.model === 'insufficient-evidence'
                ? !item.title.trim() || !item.abstract.trim()
                  ? 'missing-evidence'
                  : 'input-too-long'
                : assessment?.verdict === 'uncertain'
                  ? 'uncertain'
                  : undefined,
          assessment:
            assessment && details
              ? {
                  evidence: (() => {
                    try {
                      return smartEvidenceSchema.safeParse(
                        JSON.parse(assessment.evidenceJson ?? 'null')
                      ).data
                    } catch {
                      return undefined
                    }
                  })(),
                  ruleRevision: assessment.ruleRevision,
                  currentRuleRevision: definition.ruleRevision,
                  rule: (() => {
                    const version = ruleVersions.get(assessment.ruleRevision)
                    return version
                      ? formatSmartRule({
                          description: version.description,
                          inclusion: version.inclusionCriteria,
                          exclusion: version.exclusionCriteria
                        })
                      : undefined
                  })(),
                  model: assessment.model,
                  evaluatedAt: assessment.evaluatedAt.getTime(),
                  current: Boolean(current) && !incomplete,
                  probabilities: (() => {
                    try {
                      return z
                        .object({
                          match: z.number().min(0).max(1),
                          'no-match': z.number().min(0).max(1),
                          uncertain: z.number().min(0).max(1)
                        })
                        .safeParse(JSON.parse(assessment.probabilitiesJson)).data
                    } catch {
                      return undefined
                    }
                  })()
                }
              : undefined,
          verdict: override
            ? override === 'include'
              ? 'match'
              : 'no-match'
            : assessment &&
                assessment.model !== 'insufficient-evidence' &&
                assessment.ruleRevision !== definition.ruleRevision
              ? 'stale'
              : incomplete
                ? failed
                  ? 'error'
                  : 'pending'
                : !assessment || assessment.model === 'insufficient-evidence'
                  ? 'pending'
                  : !current
                    ? 'stale'
                    : (assessment.verdict as 'match' | 'no-match' | 'uncertain')
        })
      }
      if (items.length < 200) break
      cursor = items.at(-1)!.id
    }
    return { rows, definition, scope, where, policy, digests, checkpoint: [...failures.values()] }
  }
  async decisions(
    id: string,
    itemIds: string[],
    client?: Client
  ): Promise<SmartCollectionView['rows']> {
    if (!itemIds.length) return []
    client ??= await this.getClient()
    if (!(await client.literatureSmartCollection.findUnique({ where: { collectionId: id } })))
      return []
    return (await this.rows(id, client, itemIds)).rows
  }
  async members(
    id: string,
    client?: Client,
    filter: 'match' | 'review' | 'no-match' | 'pending' = 'match',
    source: 'all' | 'ai' | 'manual' = 'all'
  ): Promise<string[] | undefined> {
    client ??= await this.getClient()
    if (!(await client.literatureSmartCollection.count({ where: { collectionId: id } })))
      return undefined
    return (await this.rows(id, client, undefined, false)).rows
      .filter((row) => matchesDecisionSource(row, source))
      .filter((row) =>
        filter === 'review'
          ? ['uncertain', 'stale'].includes(row.verdict)
          : filter === 'pending'
            ? ['pending', 'error'].includes(row.verdict)
            : row.verdict === filter
      )
      .map((row) => row.id)
  }
  async matchingCollections(
    itemId?: string,
    projectId?: string,
    client?: Client
  ): Promise<string[]> {
    client ??= await this.getClient()
    if (projectId && !(await this.scope(client, { kind: 'project', id: projectId }))) return []
    const collections = await client.literatureSmartCollection.findMany({
      select: { collectionId: true }
    })
    const result: string[] = []
    for (const { collectionId } of collections) {
      const { rows } = await this.rows(
        collectionId,
        client,
        itemId ? [itemId] : undefined,
        false,
        projectId
      )
      if (rows.some((row) => row.verdict === 'match')) result.push(collectionId)
    }
    return result
  }
  async memberships(itemIds: string[], client?: Client): Promise<Map<string, string[]>> {
    const memberships = new Map<string, string[]>()
    if (!itemIds.length) return memberships
    client ??= await this.getClient()
    const collections = await client.literatureSmartCollection.findMany({
      select: { collectionId: true }
    })
    for (const { collectionId } of collections) {
      const { rows } = await this.rows(collectionId, client, itemIds, false)
      for (const row of rows) {
        if (row.verdict !== 'match') continue
        const ids = memberships.get(row.id) ?? []
        ids.push(collectionId)
        memberships.set(row.id, ids)
      }
    }
    return memberships
  }
  async view(
    id: string,
    offset = 0,
    filter: 'all' | 'match' | 'review' | 'no-match' | 'pending' = 'all',
    itemId?: string,
    summaryOnly = false
  ): Promise<SmartCollectionView> {
    const { rows, scope, where, policy, definition } = await this.rows(
      id,
      undefined,
      undefined,
      false
    )
    const client = await this.getClient()
    const run = await client.literatureSmartRun.findFirst({
      where: { collectionId: id },
      orderBy: { createdAt: 'desc' }
    })
    if (run && ['queued', 'running'].includes(run.state) && !this.active.has(id)) {
      await client.literatureSmartRun.update({
        where: { id: run.id },
        data: { state: 'interrupted' }
      })
      run.state = 'interrupted'
    }
    const runUsage = run
      ? await client.classificationUsage.aggregate({
          where: { runId: run.id },
          _sum: { inputTokens: true, outputTokens: true }
        })
      : undefined
    const usageIncomplete = run
      ? (await client.classificationUsage.count({
          where: { runId: run.id, usageIncomplete: true }
        })) > 0
      : false
    // Summary refreshes need bounded counts, not every checkpoint/digest in a long run.
    // Full checkpoint validation remains in the execution and resume paths.
    const runCounts = run
      ? await client.$queryRaw<Array<{ state: string; count: bigint }>>`
          SELECT state, COUNT(*) AS count FROM LiteratureSmartRunItem
          WHERE runId = ${run.id} AND deferred = 0 GROUP BY state
        `
      : []
    const runFailure = runCounts.some((group) => group.state === 'error')
      ? await client.literatureSmartRunItem.findFirst({
          where: { runId: run!.id, deferred: false, state: 'error' },
          orderBy: { itemId: 'asc' },
          select: { failure: true }
        })
      : undefined
    const inView = (row: (typeof rows)[number], decision: typeof filter): boolean =>
      decision === 'all' ||
      (decision === 'review'
        ? ['uncertain', 'stale'].includes(row.verdict)
        : decision === 'pending'
          ? ['pending', 'error'].includes(row.verdict)
          : row.verdict === decision)
    const filtered = rows.filter((row) => (!itemId || row.id === itemId) && inView(row, filter))
    const counts = { match: 0, review: 0, 'no-match': 0, pending: 0 }
    const countsBySource = {
      ai: { ...counts },
      manual: { ...counts }
    }
    let overrides = 0
    let pending = 0
    for (const row of rows) {
      const bucket =
        row.verdict === 'uncertain' || row.verdict === 'stale'
          ? 'review'
          : row.verdict === 'pending' || row.verdict === 'error'
            ? 'pending'
            : row.verdict
      counts[bucket]++
      if (row.decisionSource) countsBySource[row.decisionSource][bucket]++
      if (row.override) overrides++
      if (row.verdict === 'pending' || row.verdict === 'stale' || row.verdict === 'error') pending++
    }
    const snapshot = await this.classifier.snapshot()
    const sourceName =
      scope.kind === 'library'
        ? ''
        : scope.kind === 'collection'
          ? ((
              await client.literatureCollection.findUnique({
                where: { id: scope.id },
                select: { name: true }
              })
            )?.name ?? '')
          : ((await client.project.findUnique({ where: { id: scope.id }, select: { name: true } }))
              ?.name ?? '')
    return {
      scope,
      ruleRevision: definition.ruleRevision,
      evidenceMode: smartEvidenceModeSchema.parse(definition.evidenceMode),
      autoUpdate: definition.autoUpdate,
      automaticPauseReason:
        !this.active.has(id) && definition.automaticPauseReason
          ? (definition.automaticPauseReason as AutomaticClassificationPauseReason)
          : undefined,
      sourceName,
      model: snapshot.smartCollections?.modelId,
      overrides,
      sourceAvailable: Boolean(where),
      configured: policy.configured,
      total: rows.length,
      counts,
      countsBySource,
      matches: counts.match,
      pending,
      rows: summaryOnly
        ? []
        : await this.decisions(
            id,
            filtered.slice(offset, offset + 100).map((row) => row.id),
            client
          ),
      ...(offset + 100 < filtered.length ? { nextOffset: offset + 100 } : {}),
      ...(run
        ? {
            run: {
              id: run.id,
              snapshot: (() => {
                try {
                  return smartRunSnapshotSchema.safeParse(JSON.parse(run.snapshotJson ?? 'null'))
                    .data
                } catch {
                  return undefined
                }
              })(),
              kind: run.kind as 'preview' | 'refresh',
              state: run.state as NonNullable<SmartCollectionView['run']>['state'],
              done: runCounts.reduce(
                (sum, group) => sum + (group.state === 'pending' ? 0 : Number(group.count)),
                0
              ),
              total: runCounts.reduce((sum, group) => sum + Number(group.count), 0),
              inputTokens: Number(runUsage?._sum.inputTokens ?? 0n),
              outputTokens: Number(runUsage?._sum.outputTokens ?? 0n),
              usageIncomplete,
              failure: runFailure?.failure
                ? z.enum(classificationFailureCategories).parse(runFailure.failure)
                : undefined,
              updatedAt: run.updatedAt.getTime()
            }
          }
        : {})
    }
  }
  private async assess(
    client: Client,
    item: { id: string; title: string; abstract: string },
    description: string,
    mode: SmartEvidenceMode,
    signal: AbortSignal,
    observeUsage: Parameters<ClassifyLiterature>[0]['observeUsage'],
    usageContext: ClassificationUsageContext
  ): Promise<{
    answer: Awaited<ReturnType<ClassifyLiterature>> | undefined
    evidence: SmartEvidence
    digest: string
  }> {
    signal.throwIfAborted()
    description = smartRulePrompt(description)
    const input = await smartInput(client, item, mode)
    const evidence = await readSmartEvidence(input, description, mode, this.readEvidence)
    signal.throwIfAborted()
    const evidenceInput =
      mode === 'full-text'
        ? { coverage: evidence.source.coverage, passages: evidence.passages }
        : undefined
    const insufficient =
      !item.title.trim() ||
      (!item.abstract.trim() && !evidence.passages.length) ||
      Buffer.byteLength(
        JSON.stringify({
          title: item.title,
          abstract: item.abstract,
          ...(evidenceInput ? { evidence: evidenceInput } : {})
        }),
        'utf8'
      ) > 48000
    const answer = insufficient
      ? undefined
      : await this.classify({
          description,
          title: item.title,
          abstract: item.abstract,
          evidence: evidenceInput,
          signal,
          usageContext,
          observeUsage
        })
    if (answer?.evidenceIndex !== undefined)
      evidence.source.passage = evidence.passages[answer.evidenceIndex]
    return { answer, evidence: evidence.source, digest: input.digest }
  }

  private async preview(
    command: Extract<SmartCollectionCommand, { kind: 'preview-smart-collection' }>,
    controller: AbortController
  ): Promise<SmartCollectionPreview> {
    controller.signal.throwIfAborted()
    const policy = await this.policy()
    const preview: SmartCollectionPreview = {
      configured: policy.configured,
      rows: [],
      inputTokens: 0,
      outputTokens: 0
    }
    if (!policy.configured) return preview
    const client = await this.getClient()
    const where = await this.scope(client, command.scope)
    if (!where) throw new Error('Collection source is unavailable.')
    const items = await client.literatureItem.findMany({
      where,
      orderBy: { id: 'asc' },
      take: 4,
      select: { id: true, title: true, abstract: true }
    })
    const results = await Promise.allSettled(
      items.map(async (item) => {
        controller.signal.throwIfAborted()
        const { answer, evidence } = await this.assess(
          client,
          item,
          command.description,
          command.evidenceMode ?? 'abstract',
          controller.signal,
          ({ usage }) => {
            preview.inputTokens += usage.inputTokens
            preview.outputTokens += usage.outputTokens
          },
          { scenario: 'literature-live-preview' }
        )
        return {
          id: item.id,
          title: item.title,
          verdict: answer?.verdict ?? 'uncertain',
          ...(answer?.verdict === 'uncertain' ? { reason: 'uncertain' as const } : {}),
          ...(answer
            ? {
                assessment: {
                  evidence,
                  model: answer.model,
                  evaluatedAt: Date.now(),
                  current: true,
                  probabilities: answer.probabilities
                }
              }
            : {
                reason:
                  !item.title.trim() || !item.abstract.trim()
                    ? ('missing-evidence' as const)
                    : ('input-too-long' as const)
              })
        }
      })
    )
    const rejected = results.find((result) => result.status === 'rejected')
    if (rejected?.status === 'rejected') throw rejected.reason
    preview.rows = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []
    )
    controller.signal.throwIfAborted()
    if ((await this.policy()).key !== policy.key)
      throw new ClassificationEvaluationError('configuration')
    return preview
  }

  async execute(
    command: SmartCollectionCommand,
    automatic = false,
    resumeAutomatic = false
  ): Promise<LiteratureCatalogReceipt> {
    if (command.kind === 'read-smart-run-progress') {
      return {
        kind: 'collection',
        id: command.collectionId,
        smartRunProgress: await readSmartRunProgress(
          await this.getClient(),
          command.collectionId,
          command.runId
        )
      }
    }
    if (command.kind === 'read-smart-history') {
      const client = await this.getClient()
      const definition = await client.literatureSmartCollection.findUniqueOrThrow({
        where: { collectionId: command.collectionId },
        select: { ruleRevision: true }
      })
      const items = await client.literatureSmartRunItem.findMany({
        where: {
          itemId: command.itemId,
          state: 'done',
          resultJson: { not: null },
          run: { collectionId: command.collectionId }
        },
        include: { run: { include: { rule: true } } },
        orderBy: [{ evaluatedAt: 'desc' }, { runId: 'desc' }],
        skip: command.offset,
        take: 21
      })
      return {
        kind: 'collection',
        id: command.collectionId,
        smartHistory: {
          currentRevision: definition.ruleRevision,
          entries: items.slice(0, 20).map((item) => {
            const result = savedResultSchema.parse(JSON.parse(item.resultJson!))
            const version = item.run.rule
            return {
              runId: item.runId,
              revision: version.revision,
              rule: formatSmartRule({
                description: version.description,
                inclusion: version.inclusionCriteria,
                exclusion: version.exclusionCriteria
              }),
              model: result.answer.model,
              evaluatedAt: item.evaluatedAt!.getTime(),
              verdict: result.answer.verdict,
              probabilities: result.answer.probabilities
            }
          }),
          ...(items.length > 20 ? { nextOffset: command.offset + 20 } : {})
        }
      }
    }
    if (command.kind === 'read-smart-decisions') {
      return {
        kind: 'collection',
        id: command.collectionId,
        smartDecisions: await this.decisions(command.collectionId, command.itemIds)
      }
    }
    if (command.kind === 'cancel-smart-preview') {
      this.previews.get(command.requestId)?.abort()
      return { kind: 'collection', id: command.requestId }
    }
    if (command.kind === 'preview-smart-collection') {
      if (this.previews.has(command.requestId)) throw new Error('Preview is already running.')
      const controller = new AbortController()
      const release = acquireDataRootWriter()
      this.previews.set(command.requestId, controller)
      const work = this.preview(command, controller)
      this.previewWork.add(work)
      try {
        return { kind: 'collection', id: command.requestId, smartPreview: await work }
      } catch (error) {
        controller.abort()
        throw error
      } finally {
        this.previewWork.delete(work)
        this.previews.delete(command.requestId)
        release()
      }
    }
    if (command.kind !== 'smart-collection' || command.action !== 'read') this.reads.clear()
    const client = await this.getClient()
    if (command.kind === 'create-smart-collection') {
      serializedSmartRuleSchema.parse(command.description)
      const name = command.name.normalize('NFKC').trim().replace(/\s+/gu, ' ')
      const row = await client
        .$transaction(async (tx) => {
          if (!(await this.scope(tx, command.scope)))
            throw new Error('Collection source is unavailable.')
          const last = await tx.literatureCollection.findFirst({
            where: { parentId: null },
            orderBy: { sortOrder: 'desc' },
            select: { sortOrder: true }
          })
          const created = await tx.literatureCollection.create({
            data: {
              name,
              nameKey: name.toLowerCase(),
              description: formatSmartRule(parseSmartRule(command.description)!),
              sortOrder: (last?.sortOrder ?? -1) + 1,
              smart: {
                create: {
                  evidenceMode: command.evidenceMode ?? 'abstract',
                  autoUpdate: command.autoUpdate ?? false,
                  scopeKind: command.scope.kind,
                  scopeId: command.scope.kind === 'library' ? null : command.scope.id
                }
              }
            }
          })
          await saveSmartRuleVersion(tx, created.id)
          return created
        })
        .catch((error: unknown) => {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
            throw new Error(LITERATURE_COLLECTION_NAME_CONFLICT)
          throw error
        })
      this.changed(row.id)
      if (command.autoUpdate) this.schedule()
      return { kind: 'collection', id: row.id, smart: await this.view(row.id) }
    }
    if (command.itemIds && !['recompute', 'override'].includes(command.action))
      throw new Error('Selected papers require re-evaluation.')
    const id = command.collectionId
    const { definition } = await this.definition(client, id)
    if (command.action === 'resume-automatic') {
      const { definition } = await this.definition(client, id)
      const latest = await client.literatureSmartRun.findFirst({
        where: { collectionId: id },
        orderBy: { createdAt: 'desc' },
        select: { state: true }
      })
      return this.execute(
        {
          ...command,
          action:
            latest &&
            ['cancelled', 'interrupted'].includes(latest.state) &&
            definition.automaticPauseReason !== 'run-limit'
              ? 'resume'
              : 'refresh'
        },
        true,
        true
      )
    }
    if (command.action === 'cancel') {
      const controller = this.active.get(id)
      controller?.abort()
      const cancelled = await client.literatureSmartRun.updateMany({
        where: { collectionId: id, state: 'queued' },
        data: { state: 'cancelled' }
      })
      if (cancelled.count && this.active.get(id) === controller) this.active.delete(id)
      this.changed(id)
    } else if (command.action === 'abandon') {
      const abandonableStates =
        definition.automaticPauseReason === 'storage-error'
          ? ['interrupted', 'failed']
          : ['interrupted']
      const run = await client.literatureSmartRun.findFirst({
        where: { collectionId: id, state: { in: abandonableStates } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true }
      })
      if (run) {
        await client.$transaction(async (tx) => {
          const cancelled = await tx.literatureSmartRun.updateMany({
            where: { id: run.id, state: { in: abandonableStates } },
            data: { state: 'cancelled' }
          })
          if (cancelled.count) {
            await tx.literatureSmartCollection.updateMany({
              where: { collectionId: id },
              data: { automaticPauseReason: null }
            })
          }
        })
        this.changed(id)
      }
    } else if (command.action === 'reset-overrides') {
      await client.literatureSmartOverride.deleteMany({ where: { collectionId: id } })
      this.changed(id)
      this.schedule()
    } else if (command.action === 'override') {
      const itemIds = [...new Set(command.itemIds ?? (command.itemId ? [command.itemId] : []))]
      if (!itemIds.length || itemIds.length > 100 || !command.decision)
        throw new Error('A decision and between 1 and 100 papers are required.')
      const decision = command.decision
      const result = await client.$transaction(
        async (tx) => {
          const { where } = await this.definition(tx, id)
          const eligible = where
            ? await tx.literatureItem.findMany({
                where: { AND: [where, { id: { in: itemIds } }] },
                select: { id: true }
              })
            : []
          const valid = new Set(eligible.map((item) => item.id))
          const saved = itemIds.filter((itemId) => valid.has(itemId))
          const failed = itemIds.filter((itemId) => !valid.has(itemId))
          if (!command.itemIds && failed.length)
            throw new Error('Paper is outside the collection scope.')
          if (saved.length) {
            if (decision === 'automatic') {
              await tx.literatureSmartOverride.deleteMany({
                where: { collectionId: id, itemId: { in: saved } }
              })
            } else {
              const updatedAt = new Date()
              await tx.$executeRaw(Prisma.sql`
              INSERT INTO LiteratureSmartOverride (collectionId, itemId, decision, updatedAt)
              VALUES ${Prisma.join(saved.map((itemId) => Prisma.sql`(${id}, ${itemId}, ${decision}, ${updatedAt})`))}
              ON CONFLICT(collectionId, itemId) DO UPDATE SET decision = excluded.decision, updatedAt = excluded.updatedAt
            `)
            }
          }
          return { saved, failed }
        },
        { maxWait: 30_000 }
      )
      if (result.saved.length) {
        this.changed(id)
        if (decision === 'automatic') this.schedule()
      }
      // No full scope scan per chunk; scope removals cannot block the other valid records.
      if (command.itemIds) return { kind: 'collection', id, smartDecisionBatch: result }
      // The write is committed. A failed summary read must never report the decision as unsaved.
      try {
        return {
          kind: 'collection',
          id,
          smart: await this.view(
            id,
            command.offset,
            command.filter,
            command.itemId,
            command.summaryOnly
          )
        }
      } catch {
        return { kind: 'collection', id, smartDecisionBatch: result, smartRefreshFailed: true }
      }
    } else if (
      command.action === 'resume' ||
      command.action === 'refresh' ||
      command.action === 'recompute' ||
      command.action === 'preview'
    ) {
      if (!this.active.has(id) && !this.deleting.has(id)) {
        // Reserve before the first await: repeated requests must not start duplicate paid work.
        const controller = new AbortController()
        this.active.set(id, controller)
        let finish!: () => void
        const work = new Promise<void>((resolve) => {
          finish = resolve
        })
        this.work.set(id, work)
        let releaseWriter: (() => void) | undefined
        let release: (() => void) | undefined = () => {
          releaseWriter?.()
          if (this.work.get(id) === work) this.work.delete(id)
          finish()
        }
        try {
          releaseWriter = acquireDataRootWriter()
          const {
            rows,
            definition,
            where,
            policy,
            checkpoint: previousCheckpoint,
            digests
          } = await this.rows(id, undefined, undefined, false)
          if (
            automatic &&
            (!definition.autoUpdate || (definition.automaticPauseReason && !resumeAutomatic))
          ) {
            release?.()
            release = undefined
            this.active.delete(id)
            return { kind: 'collection', id }
          }
          if (!policy.configured) throw new Error('Classification model is not configured.')
          if (!where) throw new Error('Collection source is unavailable.')
          if (command.itemIds && command.action !== 'recompute')
            throw new Error('Selected papers require re-evaluation.')
          let run: { id: string }
          let checkpoint: Checkpoint
          if (command.action === 'resume') {
            const previous = await client.literatureSmartRun.findFirst({
              where: { collectionId: id },
              orderBy: { createdAt: 'desc' }
            })
            let snapshot: ReturnType<typeof smartRunSnapshotSchema.parse> | undefined
            try {
              snapshot = smartRunSnapshotSchema.parse(JSON.parse(previous?.snapshotJson ?? 'null'))
            } catch {
              /* Incomplete historical checkpoints are never resumed implicitly. */
            }
            if (
              !previous ||
              !snapshot ||
              !['cancelled', 'interrupted'].includes(previous.state) ||
              previous.ruleRevision !== definition.ruleRevision ||
              previous.policyKey !== policy.key ||
              snapshot.description !== definition.collection.description ||
              snapshot.evidenceMode !== definition.evidenceMode ||
              snapshot.scope.kind !== definition.scopeKind ||
              (snapshot.scope.kind !== 'library' && snapshot.scope.id !== definition.scopeId) ||
              snapshot.model !== (await this.classifier.snapshot()).smartCollections?.modelId
            )
              throw new Error(SMART_COLLECTION_RESUME_UNAVAILABLE)
            checkpoint = await this.checkpoint(client, previous.id)
            const current = checkpoint.filter((row) => !row.deferred)
            if (
              !current.some((row) => row.state === 'pending') ||
              current.some((row) => digests.get(row.id) !== row.digest)
            )
              throw new Error(SMART_COLLECTION_RESUME_UNAVAILABLE)
            const completed = await client.literatureSmartRunItem.findMany({
              where: { runId: previous.id, deferred: false, state: 'done' },
              select: { resultJson: true, evaluatedAt: true }
            })
            if (
              completed.some((row) => {
                try {
                  return (
                    !row.evaluatedAt ||
                    !savedResultSchema.safeParse(JSON.parse(row.resultJson ?? 'null')).success
                  )
                } catch {
                  return true
                }
              })
            )
              throw new Error(SMART_COLLECTION_RESUME_UNAVAILABLE)
            // Retain the existing run ID, snapshot, usage and committed per-paper results.
            // The regular worker rechecks input digests again before dispatch and commit.
            const usage = await client.classificationUsage.findMany({
              where: { runId: previous.id },
              distinct: ['scenario'],
              select: { scenario: true }
            })
            automatic =
              usage.some((entry) => entry.scenario === 'literature-automatic') ||
              (!usage.length &&
                snapshot.action === 'refresh' &&
                Boolean(definition.automaticPauseReason))
            if (
              automatic &&
              (!definition.autoUpdate || definition.automaticPauseReason === 'run-limit')
            )
              throw new Error(SMART_COLLECTION_RESUME_UNAVAILABLE)
            controller.signal.throwIfAborted()
            const resumed = await client.$transaction(async (tx) => {
              if (automatic) {
                const reserved = await tx.literatureSmartCollection.updateMany({
                  where: {
                    collectionId: id,
                    autoUpdate: true,
                    automaticPauseReason: definition.automaticPauseReason
                  },
                  data: { automaticPauseReason: 'interrupted' }
                })
                if (!reserved.count) throw new Error(SMART_COLLECTION_RESUME_UNAVAILABLE)
              }
              return tx.literatureSmartRun.updateMany({
                where: { id: previous.id, state: previous.state },
                data: { state: 'queued', updatedAt: new Date() }
              })
            })
            if (!resumed.count) throw new Error(SMART_COLLECTION_RESUME_UNAVAILABLE)
            run = previous
          } else {
            const selected = command.itemIds ? new Set(command.itemIds) : undefined
            const scopeIds = new Set(rows.map((row) => row.id))
            if (selected && [...selected].some((id) => !scopeIds.has(id)))
              throw new Error('Paper is outside the collection scope.')
            const eligible = rows.filter(
              (row) =>
                (command.action === 'recompute' || !row.override) &&
                (!selected || selected.has(row.id)) &&
                (command.action === 'recompute' ||
                  (['pending', 'stale', 'error'].includes(row.verdict) &&
                    !(
                      row.verdict === 'pending' &&
                      ['missing-evidence', 'input-too-long'].includes(row.reason ?? '')
                    )))
            )
            const chosen =
              command.action === 'preview' && eligible.length > 20
                ? Array.from(
                    { length: 20 },
                    (_, n) => eligible[Math.floor((n * eligible.length) / 20)]!
                  )
                : eligible
            // Keep unresolved failures visible even when a different selection is evaluated.
            const chosenIds = new Set(chosen.map((row) => row.id))
            checkpoint = []
            const previousById = new Map(previousCheckpoint.map((row) => [row.id, row]))
            for (const previous of previousCheckpoint) {
              if (chosenIds.has(previous.id) || !scopeIds.has(previous.id)) continue
              if (digests.get(previous.id) === previous.digest)
                checkpoint.push({ ...previous, deferred: true })
            }
            for (const row of chosen) {
              const inputDigest = digests.get(row.id)!
              const previous = previousById.get(row.id)
              if (automatic && !resumeAutomatic && previous?.digest === inputDigest) {
                checkpoint.push({ ...previous, deferred: true })
                continue
              }
              checkpoint.push({ id: row.id, digest: inputDigest, state: 'pending' })
            }
            if (automatic && !checkpoint.some((row) => row.state === 'pending' && !row.deferred)) {
              if (resumeAutomatic)
                await client.literatureSmartCollection.update({
                  where: { collectionId: id },
                  data: { automaticPauseReason: null }
                })
              release?.()
              release = undefined
              this.active.delete(id)
              return { kind: 'collection', id }
            }
            controller.signal.throwIfAborted()
            run = await client.$transaction(
              async (tx) => {
                if (automatic) {
                  // Fail closed across crashes: only a successful terminal write clears this pause.
                  const reserved = await tx.literatureSmartCollection.updateMany({
                    where: {
                      collectionId: id,
                      autoUpdate: true,
                      automaticPauseReason: definition.automaticPauseReason
                    },
                    data: { automaticPauseReason: 'interrupted' }
                  })
                  if (!reserved.count) throw new AutomaticClassificationPausedError('interrupted')
                }
                return tx.literatureSmartRun.create({
                  data: {
                    id: randomUUID(),
                    collectionId: id,
                    kind: command.action === 'preview' ? 'preview' : 'refresh',
                    state: 'queued',
                    ruleRevision: definition.ruleRevision,
                    policyKey: policy.key,
                    items: {
                      create: checkpoint.map(({ id, ...entry }) => ({ itemId: id, ...entry }))
                    },
                    snapshotJson: JSON.stringify({
                      description: definition.collection.description,
                      scope: {
                        kind: definition.scopeKind,
                        ...(definition.scopeId ? { id: definition.scopeId } : {})
                      },
                      evidenceMode: definition.evidenceMode,
                      model: (await this.classifier.snapshot()).smartCollections?.modelId,
                      action: command.action,
                      ...(selected ? { selectedCount: selected.size } : {})
                    })
                  }
                })
              },
              { maxWait: 30000 }
            )
          }
          this.queue = this.queue
            .catch(() => undefined)
            .then(() => this.run(run.id, controller, checkpoint, automatic))
            .finally(() => {
              release?.()
              if (this.active.get(id) === controller) this.active.delete(id)
              this.changed(id)
              if (this.automaticDirty) this.schedule()
            })
          // All terminal errors are persisted by run. Do not leave an unhandled shutdown failure.
          void this.queue.catch(() => undefined)
        } catch (error) {
          release?.()
          if (this.active.get(id) === controller) this.active.delete(id)
          throw error
        }
      }
    }
    try {
      return {
        kind: 'collection',
        id,
        smart: await this.view(
          id,
          command.offset,
          command.filter,
          command.itemId,
          command.summaryOnly
        )
      }
    } catch (error) {
      // The reset is committed; retrying should only reload its result.
      if (command.action !== 'reset-overrides') throw error
      return { kind: 'collection', id, smartRefreshFailed: true }
    }
  }
  private async run(
    runId: string,
    controller: AbortController,
    checkpoint: Checkpoint,
    automatic = false
  ): Promise<void> {
    // A queued cancellation is already durable and must not re-enter running.
    if (controller.signal.aborted) return
    const client = await this.getClient()
    const run = await client.literatureSmartRun.findUniqueOrThrow({
      where: { id: runId },
      include: { rule: true }
    })
    if (controller.signal.aborted || run.state === 'cancelled') return
    let progressTimer: ReturnType<typeof setTimeout> | undefined
    let persistenceFailed = false
    let pauseReason: AutomaticClassificationPauseReason | undefined
    try {
      await client.literatureSmartRun.update({ where: { id: runId }, data: { state: 'running' } })
      const pending = checkpoint.filter((row) => row.state === 'pending' && !row.deferred)
      let stop = false
      type Evaluation = {
        row: Checkpoint[number]
        answer:
          | {
              verdict: 'match' | 'no-match' | 'uncertain'
              model: string
              probabilities: Partial<Record<'match' | 'no-match' | 'uncertain', number>>
            }
          | undefined
        evidence: SmartEvidence | undefined
        error: unknown
      }
      const evaluate = async (row: Checkpoint[number]): Promise<Evaluation> => {
        try {
          const { definition, where } = await this.definition(client, run.collectionId)
          if (automatic && !definition.autoUpdate) {
            controller.abort()
            controller.signal.throwIfAborted()
          }
          if (
            definition.ruleRevision !== run.ruleRevision ||
            (await this.policy()).key !== run.policyKey
          )
            throw new ClassificationEvaluationError('configuration')

          controller.signal.throwIfAborted()
          const item =
            where &&
            (await client.literatureItem.findFirst({ where: { AND: [where, { id: row.id }] } }))
          if (
            !item ||
            (await smartInput(client, item, smartEvidenceModeSchema.parse(definition.evidenceMode)))
              .digest !== row.digest
          )
            throw new ClassificationEvaluationError('configuration')
          const evaluated = await this.assess(
            client,
            item,
            formatSmartRule({
              description: run.rule.description,
              inclusion: run.rule.inclusionCriteria,
              exclusion: run.rule.exclusionCriteria
            }),
            smartEvidenceModeSchema.parse(run.rule.evidenceMode),
            controller.signal,
            undefined,
            {
              collectionId: run.collectionId,
              runId,
              scenario: automatic
                ? 'literature-automatic'
                : run.kind === 'preview'
                  ? 'literature-trial'
                  : JSON.parse(run.snapshotJson ?? '{}').action === 'recompute'
                    ? 'literature-reevaluate'
                    : 'literature-update'
            }
          )
          if (evaluated.digest !== row.digest)
            throw new ClassificationEvaluationError('configuration')
          const answer = evaluated.answer ?? {
            verdict: 'uncertain' as const,
            model: 'insufficient-evidence',
            probabilities: {}
          }
          return {
            row,
            answer,
            evidence: evaluated.evidence,
            error: undefined
          }
        } catch (error) {
          stop = true
          return { row, answer: undefined, evidence: undefined, error }
        }
      }
      // Refill a free slot after committing a result; a slow peer no longer stalls all four.
      // Stop scheduling on the first error, but drain every started request for usage accounting.
      const results = async function* (): AsyncGenerator<Evaluation> {
        let next = 0
        const active = new Map<string, ReturnType<typeof evaluate>>()
        const fill = (): void => {
          while (!stop && !controller.signal.aborted && active.size < 4 && next < pending.length) {
            const row = pending[next++]!
            active.set(row.id, evaluate(row))
          }
        }
        fill()
        while (active.size) {
          const result = await Promise.race(active.values())
          active.delete(result.row.id)
          yield result
          fill()
        }
      }
      let invalidated = false
      let resolvedModel = (
        await client.literatureSmartAssessment.findFirst({
          where: {
            collectionId: run.collectionId,
            policyKey: run.policyKey,
            model: { not: 'insufficient-evidence' }
          },
          select: { model: true }
        })
      )?.model
      let completed = 0
      let lastProgressAt = -Infinity
      const publishProgress = (): void => {
        // Item results are already durable. Do not wait for the aggregate metadata batch.
        this.reads.clear()
        const remaining = 250 - (Date.now() - lastProgressAt)
        const emit = (): void => {
          progressTimer = undefined
          lastProgressAt = Date.now()
          this.changed(run.collectionId)
        }
        if (remaining <= 0) {
          if (progressTimer) clearTimeout(progressTimer)
          emit()
        } else if (!progressTimer) {
          // Deliver the final fast reply even if every other request remains slow.
          progressTimer = setTimeout(emit, remaining)
        }
      }
      const flush = async (): Promise<void> => {
        if (!completed) return
        await client.literatureSmartRun.update({
          where: { id: runId },
          data: {
            ...(resolvedModel ? { model: resolvedModel } : {}),
            updatedAt: new Date()
          }
        })
        completed = 0
        this.reads.clear()
      }
      for await (const { row, answer, evidence, error } of results()) {
        try {
          if (invalidated) throw new ClassificationEvaluationError('configuration')
          if (error) throw error
          if (!answer) throw new ClassificationEvaluationError('unknown')
          controller.signal.throwIfAborted()
          if (answer.model !== 'insufficient-evidence') {
            if (resolvedModel && resolvedModel !== answer.model) {
              invalidated = true
              await client.literatureSmartAssessment.updateMany({
                where: { collectionId: run.collectionId, policyKey: run.policyKey },
                data: { policyKey: `obsolete:${run.id}` }
              })
              throw new ClassificationEvaluationError('configuration')
            }
            resolvedModel = answer.model
          }
          await client.$transaction(async (tx) => {
            const current = await this.definition(tx, run.collectionId)
            const paper =
              current.where &&
              (await tx.literatureItem.findFirst({
                where: { AND: [current.where, { id: row.id }] }
              }))
            if (
              controller.signal.aborted ||
              (await this.policy()).key !== run.policyKey ||
              current.definition.ruleRevision !== run.ruleRevision ||
              !paper ||
              (
                await smartInput(
                  tx,
                  paper,
                  smartEvidenceModeSchema.parse(current.definition.evidenceMode)
                )
              ).digest !== row.digest
            )
              throw new ClassificationEvaluationError('configuration')
            const data = {
              ruleRevision: run.ruleRevision,
              inputDigest: row.digest,
              policyKey: run.policyKey,
              verdict: answer.verdict,
              model: answer.model,
              probabilitiesJson: JSON.stringify(answer.probabilities),
              evidenceJson: JSON.stringify(evidence),
              evaluatedAt: new Date()
            }
            await tx.literatureSmartAssessment.upsert({
              where: { collectionId_itemId: { collectionId: run.collectionId, itemId: row.id } },
              create: { collectionId: run.collectionId, itemId: row.id, ...data },
              update: data
            })
            await tx.literatureSmartRunItem.update({
              where: { runId_itemId: { runId, itemId: row.id } },
              data: {
                state: 'done',
                failure: null,
                resultJson: JSON.stringify({ answer, evidence }),
                evaluatedAt: data.evaluatedAt
              }
            })
          })
          row.state = 'done'
        } catch (error) {
          stop = true
          const paused = error instanceof AutomaticClassificationPausedError
          row.state = controller.signal.aborted || paused ? 'pending' : 'error'
          row.failure =
            row.state === 'pending'
              ? undefined
              : error instanceof ClassificationEvaluationError
                ? error.category
                : 'unknown'
          if (paused) pauseReason = error.reason
          else if (!controller.signal.aborted && !(error instanceof ClassificationEvaluationError))
            persistenceFailed = true
          try {
            await client.literatureSmartRunItem.update({
              where: { runId_itemId: { runId, itemId: row.id } },
              data: { state: row.state, failure: row.failure ?? null }
            })
          } catch {
            persistenceFailed = true
          }
        }
        completed++
        publishProgress()
        if (completed >= 4) {
          try {
            await flush()
          } catch {
            stop = true
            persistenceFailed = true
          } // Drain started calls before retrying persistence.
        }
      }
      await flush()
      if (persistenceFailed) throw new Error('Could not save classification progress.')
      controller.signal.throwIfAborted()
      await client.literatureSmartRun.update({
        where: { id: runId },
        data: {
          state: checkpoint.some((row) => !row.deferred && row.state === 'error')
            ? 'failed'
            : pauseReason
              ? 'interrupted'
              : 'completed',
          updatedAt: new Date()
        }
      })
    } catch (error) {
      if (!controller.signal.aborted && !(error instanceof ClassificationEvaluationError))
        persistenceFailed = true
      if (!controller.signal.aborted && error instanceof ClassificationEvaluationError) {
        const pending = checkpoint.find((row) => !row.deferred && row.state === 'pending')
        if (pending) {
          pending.state = 'error'
          pending.failure = error.category
          await client.literatureSmartRunItem.update({
            where: { runId_itemId: { runId, itemId: pending.id } },
            data: { state: 'error', failure: pending.failure }
          })
        }
      }
      await client.literatureSmartRun.updateMany({
        where: { id: runId },
        data: {
          state: controller.signal.aborted ? 'cancelled' : 'failed',
          updatedAt: new Date()
        }
      })
    } finally {
      // The queue's terminal notification always publishes the final state.
      if (progressTimer) clearTimeout(progressTimer)
      if (automatic) {
        try {
          await client.literatureSmartCollection.updateMany({
            where: { collectionId: run.collectionId, automaticPauseReason: 'interrupted' },
            data: {
              automaticPauseReason: persistenceFailed
                ? 'storage-error'
                : (pauseReason ?? (controller.signal.aborted ? 'interrupted' : null))
            }
          })
        } catch {
          /* Prearmed durable pause stays set when storage is unavailable. */
        }
      }
    }
  }
}
