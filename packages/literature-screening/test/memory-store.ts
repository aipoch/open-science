import { randomUUID } from 'node:crypto'
import type {
  ScreeningDatabase,
  ScreeningStore,
  ScreeningDefinition,
  ScreeningRun,
  ScreeningRunItem,
  ScreeningRuleVersion,
  ScreeningPaper,
  ScreeningAssessment,
  ScreeningDocument,
  SmartScope
} from '@aipoch/literature-screening'
import { parseSmartRule } from '@aipoch/literature-screening/rules'

/** Independent reference adapter: no ORM, host schema, files or migrations. */
export class MemoryScreeningStore {
  papers = new Map<string, ScreeningPaper>()
  definitions = new Map<string, ScreeningDefinition>()
  rules = new Map<string, ScreeningRuleVersion>()
  runs = new Map<string, ScreeningRun>()
  items = new Map<string, ScreeningRunItem>()
  assessments = new Map<string, ScreeningAssessment>()
  overrides = new Map<string, string>()
  documents = new Map<string, ScreeningDocument>()
  scopes = new Map<string, Set<string>>()
  usage = new Map<
    string,
    {
      inputTokens: number
      outputTokens: number
      incomplete: boolean
      scenarios: { scenario: string }[]
    }
  >()
  version = 0
  serial = 0
  failCommit = false
  private queue: Promise<unknown> = Promise.resolve()
  touch(): void {
    this.version++
  }
  seed(id = 'paper', title = 'Research', abstract = 'Original study'): void {
    this.papers.set(id, { id, title, abstract })
    this.touch()
  }
  edit(id: string, patch: Partial<ScreeningPaper>): void {
    Object.assign(this.papers.get(id)!, patch)
    this.touch()
  }
  updateRule(id: string, description: string): void {
    const definition = this.definitions.get(id)!
    definition.ruleRevision++
    definition.collection.description = description
    this.saveRule(definition)
    this.touch()
  }
  private saveRule(d: ScreeningDefinition): void {
    const rule = parseSmartRule(d.collection.description)!
    this.rules.set(`${d.collectionId}:${d.ruleRevision}`, {
      revision: d.ruleRevision,
      description: rule.description,
      inclusionCriteria: rule.inclusion,
      exclusionCriteria: rule.exclusion,
      scopeKind: d.scopeKind,
      scopeId: d.scopeId,
      evidenceMode: d.evidenceMode
    })
  }
  private eligible(scope: SmartScope, id: string): boolean {
    return (
      this.papers.has(id) &&
      (scope.kind === 'library' || this.scopes.get(`${scope.kind}:${scope.id}`)?.has(id) === true)
    )
  }
  readonly database: ScreeningDatabase = {
    listCollections: async (automaticOnly) =>
      [...this.definitions.values()]
        .filter((d) => !automaticOnly || d.autoUpdate)
        .map((d) => ({
          collectionId: d.collectionId,
          automaticPauseReason: d.automaticPauseReason
        })),
    definition: async (id) => structuredClone(this.definitions.get(id) ?? null),
    scopeAvailable: async (scope) =>
      scope.kind === 'library' || this.scopes.has(`${scope.kind}:${scope.id}`),
    sourceName: async (scope) => (scope.kind === 'library' ? '' : scope.id),
    papers: async (scope, scan = {}) =>
      [...this.papers.values()]
        .filter(
          (p) =>
            this.eligible(scope, p.id) &&
            (!scan.itemIds || scan.itemIds.includes(p.id)) &&
            (!scan.projectId || this.scopes.get(`project:${scan.projectId}`)?.has(p.id)) &&
            (!scan.after || p.id > scan.after)
        )
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, scan.limit)
        .map((p) => {
          const assessment = this.assessments.get(`${scan.collectionId}:${p.id}`),
            decision = this.overrides.get(`${scan.collectionId}:${p.id}`)
          return structuredClone({
            ...p,
            smartAssessments: assessment ? [assessment] : [],
            smartOverrides: decision ? [{ decision }] : []
          })
        }),
    paper: async (scope, id) =>
      this.eligible(scope, id) ? structuredClone(this.papers.get(id)!) : null,
    documents: async (ids) =>
      ids.map((itemId) => ({
        itemId,
        document: structuredClone(this.documents.get(itemId) ?? null)
      })),
    ruleVersions: async (id, revisions) =>
      revisions.flatMap((v) => {
        const row = this.rules.get(`${id}:${v}`)
        return row ? [structuredClone(row)] : []
      }),
    hasOutdatedRun: async (id, revision) =>
      [...this.runs.values()].some(
        (r) =>
          r.collectionId === id &&
          ['queued', 'running'].includes(r.state) &&
          r.ruleRevision !== revision
      ),
    findRun: async (selection) =>
      structuredClone(
        [...this.runs.values()].find(
          (r) =>
            (!selection.id || r.id === selection.id) &&
            (!selection.collectionId || r.collectionId === selection.collectionId) &&
            (!selection.states || selection.states.includes(r.state))
        ) ?? null
      ),
    latestRuns: async (id, limit = 1) =>
      structuredClone(
        [...this.runs.values()]
          .filter((r) => r.collectionId === id)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, limit)
      ),
    run: async (id) => {
      const run = this.runs.get(id)
      if (!run) throw Error('Missing run')
      return structuredClone({
        ...run,
        rule: this.rules.get(`${run.collectionId}:${run.ruleRevision}`)!
      })
    },
    runItems: async ({ runId, states, deferred, itemId, unfinished }) =>
      structuredClone(
        [...this.items.values()]
          .filter(
            (r) =>
              r.runId === runId &&
              (!unfinished || r.state !== 'done') &&
              (!states || states.includes(r.state)) &&
              (deferred === undefined || r.deferred === deferred) &&
              (!itemId || r.itemId === itemId)
          )
          .sort((a, b) => a.itemId.localeCompare(b.itemId))
      ),
    history: async (collectionId, itemId, offset) =>
      structuredClone(
        [...this.items.values()]
          .filter(
            (i) =>
              i.itemId === itemId &&
              i.state === 'done' &&
              i.resultJson &&
              this.runs.get(i.runId)?.collectionId === collectionId
          )
          .sort((a, b) => b.evaluatedAt!.getTime() - a.evaluatedAt!.getTime())
          .slice(offset, offset + 21)
          .map((i) => ({
            ...i,
            run: {
              rule: this.rules.get(`${collectionId}:${this.runs.get(i.runId)!.ruleRevision}`)!
            }
          }))
      ),
    usage: async (id) =>
      structuredClone(
        this.usage.get(id) ?? { inputTokens: 0, outputTokens: 0, incomplete: false, scenarios: [] }
      ),
    runCounts: async (runId) => {
      const counts = new Map<string, number>()
      for (const i of this.items.values())
        if (i.runId === runId && !i.deferred) counts.set(i.state, (counts.get(i.state) ?? 0) + 1)
      return [...counts].map(([state, count]) => ({ state, count }))
    },
    runFailure: async (runId) =>
      structuredClone(
        [...this.items.values()]
          .filter((i) => i.runId === runId && !i.deferred && i.state === 'error')
          .sort((a, b) => a.itemId.localeCompare(b.itemId))[0] ?? null
      ),
    progress: async (collectionId, runId) => {
      const run = this.runs.get(runId)
      if (!run || run.collectionId !== collectionId) throw Error('Missing run')
      const items = await this.database.runItems({ runId, deferred: false })
      const counts = { match: 0, review: 0, noMatch: 0, pending: 0, error: 0, unavailable: 0 }
      for (const item of items) {
        if (item.state === 'pending' || item.state === 'error') {
          counts[item.state]++
          continue
        }
        let key: keyof typeof counts = 'unavailable'
        try {
          const { answer } = JSON.parse(item.resultJson ?? 'null')
          if (answer.model !== 'insufficient-evidence')
            key =
              answer.verdict === 'match'
                ? 'match'
                : answer.verdict === 'no-match'
                  ? 'noMatch'
                  : answer.verdict === 'uncertain'
                    ? 'review'
                    : 'unavailable'
        } catch {
          /* Incomplete persisted outcomes have no inferred verdict. */
        }
        counts[key]++
      }
      return {
        state: run.state,
        counts,
        candidates: items.filter((i) => i.state === 'pending').slice(0, 4),
        outcomes: items.filter((i) => i.state !== 'pending').slice(0, 24),
        titles: [...this.papers.values()],
        overrides: [...this.overrides]
          .filter(([key]) => key.startsWith(collectionId + ':'))
          .map(([key, decision]) => ({ itemId: key.slice(collectionId.length + 1), decision }))
      }
    },
    createCollection: async (input) => {
      const id = randomUUID()
      const d: ScreeningDefinition = {
        collectionId: id,
        scopeKind: input.scope.kind,
        scopeId: input.scope.kind === 'library' ? null : input.scope.id,
        ruleRevision: 1,
        evidenceMode: input.evidenceMode,
        autoUpdate: input.autoUpdate,
        automaticPauseReason: null,
        automaticPauseRunId: null,
        collection: { description: input.description }
      }
      this.definitions.set(id, d)
      this.saveRule(d)
      this.touch()
      return { id }
    },
    createRun: async ({ items, ...input }) => {
      const now = new Date(Date.now() + this.serial++)
      this.runs.set(input.id, {
        ...input,
        createdAt: now,
        updatedAt: now,
        abandonedAt: null,
        model: null
      })
      for (const item of items)
        this.items.set(`${input.id}:${item.itemId}`, {
          runId: input.id,
          failure: null,
          deferred: false,
          resultJson: null,
          evaluatedAt: null,
          ...item
        })
      this.touch()
      return { id: input.id }
    },
    updateRun: async (id, patch) => {
      const run = this.runs.get(id)
      if (!run) throw Error('Missing run')
      Object.assign(run, patch)
      this.touch()
    },
    updateRuns: async (selection, patch) => {
      let count = 0
      for (const run of this.runs.values())
        if (
          (!selection.id || run.id === selection.id) &&
          (!selection.collectionId || run.collectionId === selection.collectionId) &&
          (!selection.states || selection.states.includes(run.state)) &&
          (selection.abandoned !== false || run.abandonedAt === null)
        ) {
          Object.assign(run, patch)
          count++
        }
      this.touch()
      return count
    },
    updateRunItems: async (selection, patch) => {
      for (const row of this.items.values())
        if (
          row.runId === selection.runId &&
          (!selection.itemId || row.itemId === selection.itemId) &&
          (!selection.states || selection.states.includes(row.state)) &&
          (selection.deferred === undefined || row.deferred === selection.deferred)
        )
          Object.assign(row, patch)
      this.touch()
    },
    updatePause: async (id, expected, patch) => {
      const d = this.definitions.get(id)
      if (
        !d ||
        Object.entries(expected).some(
          ([key, value]) => d[key as keyof ScreeningDefinition] !== value
        )
      )
        return 0
      Object.assign(d, patch)
      this.touch()
      return 1
    },
    clearOverrides: async (id, items) => {
      for (const key of this.overrides.keys())
        if (key.startsWith(id + ':') && (!items || items.includes(key.slice(id.length + 1))))
          this.overrides.delete(key)
      this.touch()
    },
    saveOverrides: async (id, items, decision) => {
      for (const item of items) this.overrides.set(`${id}:${item}`, decision)
      this.touch()
    },
    resolvedModel: async (id, policy) =>
      [...this.assessments].find(
        ([key, a]) =>
          key.startsWith(id + ':') && a.policyKey === policy && a.model !== 'insufficient-evidence'
      )?.[1].model,
    invalidateAssessments: async (id, policy, next) => {
      for (const [key, a] of this.assessments)
        if (key.startsWith(id + ':') && a.policyKey === policy) a.policyKey = next
      this.touch()
    },
    saveAssessment: async (id, item, data) => {
      this.assessments.set(`${id}:${item}`, structuredClone(data))
      this.touch()
    },
    revision: async () => String(this.version),
    transaction: async <T>(operation: (store: ScreeningStore) => Promise<T>): Promise<T> => {
      const work = this.queue
        .catch(() => {})
        .then(async () => {
          const keys = [
            'definitions',
            'rules',
            'runs',
            'items',
            'assessments',
            'overrides'
          ] as const
          const snapshot = structuredClone(keys.map((key) => this[key]))
          try {
            const result = await operation({ ...this.database })
            if (this.failCommit) throw Error('Storage unavailable')
            return result
          } catch (error) {
            keys.forEach((key, i) => {
              ;(this as unknown as Record<string, unknown>)[key] = snapshot[i]
            })
            this.touch()
            throw error
          }
        })
      this.queue = work
      return work
    }
  }
}
