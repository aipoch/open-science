import { randomUUID } from 'node:crypto'
import { ReproductionPreflightError } from './reproduction-preflight'
import type { SessionReproducibilityStore } from './session-reproducibility-store'
import { createLogger, errorLogFields } from '../logger'
const log = createLogger('artifacts:session-reproducibility')
import type {
  SessionReproducibilityBatch,
  SessionReproducibilityCommand
} from '../../shared/session-reproducibility'
import { sessionReproducibilityCommandSchema } from '../../shared/session-reproducibility'
import type {
  ArtifactReproducibilityCheckRequest,
  ArtifactReproducibilityCheckState
} from '../../shared/artifact-reproducibility'

type Scope = Pick<SessionReproducibilityBatch, 'projectId' | 'appSessionId'>
type Entry = {
  ownerId: number
  state: SessionReproducibilityBatch
  requests: ArtifactReproducibilityCheckRequest[]
  controller: AbortController
  settled: Promise<void>
}
type Dependencies = {
  store?: Pick<SessionReproducibilityStore, 'load' | 'save'>
  preflight: (
    request: ArtifactReproducibilityCheckRequest,
    signal: AbortSignal
  ) => Promise<{ recipeId: string; steps: number; inputBytes: number; environmentCount: number }>
  run: (
    request: ArtifactReproducibilityCheckRequest,
    publish: (state: ArtifactReproducibilityCheckState) => void,
    ownerId: number
  ) => Promise<ArtifactReproducibilityCheckState>
  cancel: (attemptId: string, ownerId: number) => void
}

// A Session batch schedules immutable Artifact Versions. It does not invent a combined kernel
// history or merge runs from different snapshots. Individual receipts remain the audit authority.
export class SessionReproducibilityBatches {
  private readonly entries = new Map<string, Entry>()
  private loadGeneration = 0
  constructor(private readonly dependencies: Dependencies) {}
  private key(scope: Scope, ownerId: number): string {
    return JSON.stringify([ownerId, scope.projectId, scope.appSessionId])
  }

  async command(
    raw: SessionReproducibilityCommand,
    ownerId: number
  ): Promise<SessionReproducibilityBatch | undefined> {
    const request = sessionReproducibilityCommandSchema.parse(raw)
    const key = this.key(request, ownerId)
    let current = this.entries.get(key)
    if (
      !current &&
      request.action === 'get' &&
      ![...this.entries.values()].some(
        (entry) =>
          entry.state.projectId === request.projectId &&
          entry.state.appSessionId === request.appSessionId
      )
    ) {
      const generation = this.loadGeneration
      const saved = await this.dependencies.store?.load(request)
      if (generation !== this.loadGeneration) return undefined
      const admitted = this.entries.get(key)
      if (admitted) return structuredClone(admitted.state)
      if (
        [...this.entries.values()].some(
          (entry) =>
            entry.state.projectId === request.projectId &&
            entry.state.appSessionId === request.appSessionId
        )
      )
        return undefined
      // A new process never resumes a half-restored kernel or an old preflight admission.
      if (saved) {
        if (this.entries.size >= 64) {
          const idle = [...this.entries].find(
            ([, entry]) => !['preparing', 'running'].includes(entry.state.status)
          )
          if (!idle) return undefined
          this.entries.delete(idle[0])
        }
        if (saved.status !== 'completed') {
          saved.status = 'cancelled'
          for (const row of saved.targets)
            if (['pending', 'queued', 'running'].includes(row.status)) row.status = 'cancelled'
        }
        current = {
          ownerId,
          state: saved,
          controller: new AbortController(),
          settled: Promise.resolve(),
          requests: []
        }
        this.entries.set(key, current)
      }
    }
    if (request.action === 'get') return current ? structuredClone(current.state) : undefined
    if (request.action === 'prepare') {
      const others = [...this.entries].filter(
        ([entryKey, entry]) =>
          entryKey !== key &&
          entry.state.projectId === request.projectId &&
          entry.state.appSessionId === request.appSessionId
      )
      if (others.some(([, entry]) => ['preparing', 'running'].includes(entry.state.status)))
        throw new Error('A Session check is already active.')
      for (const [entryKey] of others) this.entries.delete(entryKey)
      if (current && ['preparing', 'running'].includes(current.state.status))
        throw new Error('A Session check is already active.')
      const identities = request.targets.map((t) => JSON.stringify([t.artifactId, t.versionId]))
      if (new Set(identities).size !== identities.length)
        throw new Error('Duplicate Artifact Versions.')
      if (!current && this.entries.size >= 64) {
        const idle = [...this.entries].find(
          ([, entry]) => !['preparing', 'running'].includes(entry.state.status)
        )
        if (!idle) throw new Error('Too many active Session checks.')
        this.entries.delete(idle[0])
      }
      const entry: Entry = {
        ownerId,
        controller: new AbortController(),
        settled: Promise.resolve(),
        state: {
          batchId: randomUUID(),
          projectId: request.projectId,
          appSessionId: request.appSessionId,
          createdAt: new Date().toISOString(),
          status: 'preparing',
          targets: request.targets.map((t) => ({ ...t, status: 'pending' })),
          ...(request.comparisonPolicy ? { comparisonPolicy: request.comparisonPolicy } : {})
        },
        requests: request.targets.map((t) => ({
          projectId: request.projectId,
          appSessionId: request.appSessionId,
          artifactId: t.artifactId,
          versionId: t.versionId,
          frontierId: 'original-inputs',
          comparisonPolicy: request.comparisonPolicy
        }))
      }
      this.entries.set(key, entry)
      entry.settled = this.prepare(entry)
      await entry.settled
      return structuredClone(entry.state)
    }
    if (!current || current.state.batchId !== request.batchId)
      throw new Error('Session check is no longer current.')
    if (request.action === 'cancel') {
      this.stop(current)
      await current.settled
    } else {
      if (current.state.status !== 'ready')
        throw new Error('Prepare the Session check before starting.')
      current.state.status = 'running'
      const entry = current
      // Include admission publication in the drain barrier: deleting a Session must not race a
      // delayed write which would recreate its directory after deletion.
      current.settled = (async () => {
        await this.dependencies.store?.save(structuredClone(entry.state))
        if (!entry.controller.signal.aborted) await this.run(entry)
      })().catch((error) => {
        this.stop(current!)
        log.error('batch checkpoint failed', errorLogFields(error))
      })
    }
    return structuredClone(current.state)
  }

  private async prepare(entry: Entry): Promise<void> {
    for (const [index, request] of entry.requests.entries()) {
      if (entry.controller.signal.aborted) break
      const target = entry.state.targets[index]!
      try {
        const result = await this.dependencies.preflight(request, entry.controller.signal)
        if (entry.controller.signal.aborted) break
        Object.assign(target, result, { status: 'queued' })
        request.expectedRecipeId = result.recipeId
      } catch (error) {
        if (entry.controller.signal.aborted) break
        target.status = 'blocked'
        target.reason =
          error instanceof ReproductionPreflightError ? error.reason : 'preflight-failed'
      }
    }
    if (entry.controller.signal.aborted) this.stop(entry)
    else entry.state.status = 'ready'
    await this.dependencies.store?.save(structuredClone(entry.state))
  }

  private async run(entry: Entry): Promise<void> {
    for (const [index, request] of entry.requests.entries()) {
      if (entry.controller.signal.aborted) break
      const target = entry.state.targets[index]!
      if (target.status !== 'queued') continue
      await this.dependencies.store?.save(structuredClone(entry.state))
      if (entry.controller.signal.aborted) break
      try {
        const result = await this.dependencies.run(
          request,
          (state) => {
            target.attemptId = state.attemptId
            target.status = state.status
            if (state.receipt) target.receiptChecksum = state.receipt.receiptChecksum
          },
          entry.ownerId
        )
        target.status = result.status
        if (result.receipt) target.receiptChecksum = result.receipt.receiptChecksum
      } catch {
        target.status = entry.controller.signal.aborted ? 'cancelled' : 'failed'
      }
    }
    entry.state.status = entry.controller.signal.aborted ? 'cancelled' : 'completed'
    await this.dependencies.store?.save(structuredClone(entry.state))
  }

  private stop(entry: Entry): void {
    if (entry.state.status === 'completed') return
    entry.controller.abort()
    entry.state.status = 'cancelled'
    for (const target of entry.state.targets) {
      if (target.status === 'running' && target.attemptId)
        this.dependencies.cancel(target.attemptId, entry.ownerId)
      if (target.status === 'queued' || target.status === 'pending') target.status = 'cancelled'
    }
  }
  async stopWhere(matches: (scope: Scope, ownerId: number) => boolean): Promise<void> {
    this.loadGeneration++
    const entries = [...this.entries.values()].filter((e) => matches(e.state, e.ownerId))
    for (const entry of entries) this.stop(entry)
    await Promise.all(entries.map((entry) => entry.settled))
    await Promise.all(
      entries.map((entry) => this.dependencies.store?.save(structuredClone(entry.state)))
    )
    for (const [key, entry] of this.entries) if (entries.includes(entry)) this.entries.delete(key)
  }
  activeSessions(): Array<{ projectId: string; sessionId: string }> {
    return [...this.entries.values()]
      .filter((entry) => ['preparing', 'running'].includes(entry.state.status))
      .map((entry) => ({ projectId: entry.state.projectId, sessionId: entry.state.appSessionId }))
  }
}
