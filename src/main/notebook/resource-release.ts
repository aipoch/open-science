import { randomUUID } from 'node:crypto'
import type { RuntimeDiagnosticLogger } from '@aipoch/diagnostics/node'
import type {
  NotebookProjectResources,
  NotebookResourceMemory,
  NotebookResource,
  NotebookResourceRelease,
  NotebookResourceReleaseRequest,
  ReleaseNotebookSessionResourcesRequest
} from '../../shared/notebook-resources'
import { acquireDataRootWriter, withDataRootWrite } from '../storage/migration-state'
import type {
  NotebookExecutionContinuation,
  NotebookExecutionIntentScope
} from './execution-intent'
import {
  releaseNotebookResources,
  type NotebookOwnedResource,
  type NotebookResourceCleanupResult
} from './owned-resources'

type Scope = NotebookExecutionIntentScope
type Confirmation = { revision: string; resources: NotebookOwnedResource[] }
type Release = {
  view: NotebookResourceRelease
  resources: NotebookOwnedResource[]
  results: Map<object, NotebookResourceCleanupResult>
}
type Dependencies = {
  resources: (scope: { projectId?: string; sessionId?: string }) => NotebookOwnedResource[]
  hold: (scope: Scope, resources: readonly NotebookOwnedResource[]) => () => void
  observe: (scope: Scope, operation: Promise<void>) => void
  block: (scope: Scope) => readonly NotebookExecutionContinuation[]
  decisions: (projectId: string) => readonly NotebookExecutionContinuation[]
  changed: () => void
  blockedReason: (scope: Scope, scopeHeld?: boolean) => string | undefined
  logger: Pick<RuntimeDiagnosticLogger, 'info' | 'error'>
}

const completedReleaseLimitPerProject = 20
const keyFor = (scope: Scope): string => JSON.stringify([scope.projectId, scope.sessionId])
const sameResource = (left: NotebookOwnedResource, right: NotebookOwnedResource): boolean =>
  left.identity === right.identity &&
  left.group === right.group &&
  left.projectId === right.projectId &&
  left.sessionId === right.sessionId &&
  left.laneKey === right.laneKey &&
  left.executorGeneration === right.executorGeneration &&
  left.kernelEpochId === right.kernelEpochId &&
  left.processKey === right.processKey &&
  left.executionDomain === right.executionDomain &&
  left.kind === right.kind &&
  left.environment === right.environment
const sameSet = (
  left: readonly NotebookOwnedResource[],
  right: readonly NotebookOwnedResource[]
): boolean =>
  left.length === right.length &&
  left.every((entry) => right.some((other) => sameResource(entry, other)))

// Keeps confirmation/result metadata only. All inventory and retry capabilities come from the
// original owners; this module never reconstructs a resource from a pid, history or a view id.
export class NotebookResourceReleaseOwner {
  private readonly ids = new WeakMap<object, string>()
  private readonly confirmations = new Map<string, Confirmation>()
  private readonly releases = new Map<string, Release>()
  private readonly memory = new WeakMap<object, NotebookResourceMemory>()
  private sampling?: Promise<void>
  private lastSampleAt = -Infinity

  constructor(private readonly dependencies: Dependencies) {}

  private retainCompletedReleases(): void {
    const completed = new Map<string, string[]>()
    for (const [operationId, { view }] of this.releases) {
      if (view.status !== 'released') continue
      const ids = completed.get(view.projectId) ?? []
      ids.push(operationId)
      completed.set(view.projectId, ids)
    }
    for (const ids of completed.values())
      for (const operationId of ids.slice(0, -completedReleaseLimitPerProject))
        this.releases.delete(operationId)
  }

  private complete(release: Release): void {
    // A retry may finish long after its original request. Refresh insertion order so retention is
    // based on completion, not on when the first attempt was created.
    this.releases.delete(release.view.operationId)
    this.releases.set(release.view.operationId, release)
  }

  private id(resource: NotebookOwnedResource): string {
    let id = this.ids.get(resource.identity)
    if (!id) this.ids.set(resource.identity, (id = randomUUID()))
    return id
  }

  private resource(resource: NotebookOwnedResource): NotebookResource {
    return {
      id: this.id(resource),
      group: resource.group,
      kind: resource.kind,
      phase: resource.phase,
      ...(Number.isFinite(resource.startedAt) ? { startedAt: resource.startedAt } : {}),
      laneKey: resource.laneKey,
      environment: resource.environment,
      memory: this.memory.get(resource.identity) ?? {
        sampledAt: Date.now(),
        coverage: 'unknown',
        metric: process.platform === 'win32' ? 'private-bytes-and-working-set' : 'rss'
      }
    }
  }

  private view(release: Release): NotebookResourceRelease {
    return structuredClone({
      ...release.view,
      continuations: release.view.continuations.filter((continuation) =>
        this.dependencies
          .decisions(continuation.projectId)
          .some(
            (current) =>
              current.sessionId === continuation.sessionId &&
              current.refusalId === continuation.refusalId
          )
      )
    })
  }

  async project(projectId: string): Promise<NotebookProjectResources> {
    await this.sampleMemory(this.dependencies.resources({ projectId }))
    const grouped = new Map<string, { scope: Scope; resources: NotebookOwnedResource[] }>()
    for (const resource of this.dependencies.resources({ projectId })) {
      if (!resource.projectId || !resource.sessionId) continue
      const scope = { projectId: resource.projectId, sessionId: resource.sessionId }
      const key = keyFor(scope)
      const group = grouped.get(key) ?? { scope, resources: [] }
      if (!group.resources.some((entry) => sameResource(entry, resource)))
        group.resources.push(resource)
      grouped.set(key, group)
    }
    for (const key of this.confirmations.keys()) {
      const [confirmedProject] = JSON.parse(key) as [string, string]
      if (confirmedProject === projectId && !grouped.has(key)) this.confirmations.delete(key)
    }
    return {
      groups: [...grouped.entries()].map(([key, { scope, resources }]) => {
        let confirmation = this.confirmations.get(key)
        if (!confirmation || !sameSet(confirmation.resources, resources)) {
          confirmation = { revision: randomUUID(), resources }
          this.confirmations.set(key, confirmation)
        }
        const running = [...this.releases.values()].find(
          ({ view }) => keyFor(view) === key && view.status === 'releasing'
        )
        return {
          ...scope,
          revision: confirmation.revision,
          resources: resources.map((resource) => this.resource(resource)),
          releaseBlockedReason: running
            ? 'release-in-progress'
            : this.dependencies.blockedReason(scope),
          operationId: running?.view.operationId
        }
      }),
      pendingDecisions: [...this.dependencies.decisions(projectId)],
      releases: [...this.releases.values()]
        .filter(({ view }) => view.projectId === projectId)
        .map((release) => this.view(release))
    }
  }

  private async sampleMemory(resources: readonly NotebookOwnedResource[]): Promise<void> {
    if (!this.sampling && performance.now() - this.lastSampleAt >= 5_000) {
      this.lastSampleAt = performance.now()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 1_500)
      const work = (async () => {
        const counted = new Set<string>()
        for (const resource of resources.slice(0, 128)) {
          if (controller.signal.aborted) break
          if (!resource.sampleMemory) continue
          try {
            const sample = await resource.sampleMemory(controller.signal)
            if (controller.signal.aborted) break
            const processes = sample.processes.filter(({ pid, birth }) => {
              const key = JSON.stringify([pid, birth])
              if (counted.has(key)) return false
              counted.add(key)
              return true
            })
            this.memory.set(resource.identity, {
              sampledAt: sample.sampledAt,
              metric: sample.metric,
              coverage: !processes.length
                ? 'unknown'
                : sample.complete && processes.length === sample.processes.length
                  ? 'complete'
                  : 'partial',
              ...(processes.length
                ? sample.metric === 'rss'
                  ? { rssBytes: processes.reduce((sum, entry) => sum + (entry.rssBytes ?? 0), 0) }
                  : {
                      privateBytes: processes.reduce(
                        (sum, entry) => sum + (entry.privateBytes ?? 0),
                        0
                      ),
                      workingSetBytes: processes.reduce(
                        (sum, entry) => sum + (entry.workingSetBytes ?? 0),
                        0
                      )
                    }
                : {})
            })
          } catch {
            /* Unavailable diagnostics never replace original cleanup authority. */
          }
        }
      })().finally(() => {
        clearTimeout(timer)
        if (this.sampling === work) this.sampling = undefined
      })
      this.sampling = work
    }
    if (this.sampling) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        this.sampling,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1_500)
        })
      ]).finally(() => clearTimeout(timer))
    }
  }

  release(
    request: ReleaseNotebookSessionResourcesRequest,
    assertCurrent: () => void
  ): NotebookResourceRelease {
    assertCurrent()
    const existing = [...this.releases.values()].find(
      ({ view }) => keyFor(view) === keyFor(request) && view.revision === request.revision
    )
    if (existing) return this.view(existing)
    const confirmation = this.confirmations.get(keyFor(request))
    if (!confirmation || confirmation.revision !== request.revision)
      throw new Error('Notebook resources changed. Refresh and confirm the current resource set.')
    return this.commit(request, confirmation.resources, assertCurrent).view
  }

  get(request: NotebookResourceReleaseRequest): NotebookResourceRelease {
    const release = this.find(request)
    return this.view(release)
  }

  retry(
    request: NotebookResourceReleaseRequest,
    assertCurrent: () => void
  ): NotebookResourceRelease {
    assertCurrent()
    const release = this.find(request)
    if (release.view.status !== 'partial') return this.view(release)
    const resources = release.resources.filter((resource) => {
      const result = release.results.get(resource.identity)
      return !result?.reaped || result.projection === 'failed'
    })
    return this.commit(release.view, resources, assertCurrent, release).view
  }

  private find(request: NotebookResourceReleaseRequest): Release {
    const release = this.releases.get(request.operationId)
    if (!release || keyFor(release.view) !== keyFor(request))
      throw new Error('Notebook release operation is unavailable for this Session.')
    return release
  }

  private commit(
    request: ReleaseNotebookSessionResourcesRequest,
    resources: NotebookOwnedResource[],
    assertCurrent: () => void,
    retry?: Release
  ): { view: NotebookResourceRelease } {
    const scope = { projectId: request.projectId, sessionId: request.sessionId }
    const releaseHold = this.dependencies.hold(scope, resources)
    let releaseWriter: (() => void) | undefined
    try {
      if (!retry && !sameSet(resources, this.dependencies.resources(scope)))
        throw new Error('Notebook resources changed. Refresh and confirm the current resource set.')
      assertCurrent()
      const reason = this.dependencies.blockedReason(scope, true)
      if (reason) throw new Error(`Notebook resources cannot be released: ${reason}`)
      releaseWriter = acquireDataRootWriter()
      for (const resource of resources) resource.retainForRelease?.()
      const continuations = retry ? retry.view.continuations : [...this.dependencies.block(scope)]
      const release: Release = retry ?? {
        view: {
          operationId: randomUUID(),
          ...scope,
          revision: request.revision,
          status: 'releasing',
          startedAt: Date.now(),
          resources: resources.map((resource) => ({
            id: this.id(resource),
            group: resource.group,
            kind: resource.kind,
            laneKey: resource.laneKey,
            environment: resource.environment,
            status: 'pending'
          })),
          continuations
        },
        resources,
        results: new Map()
      }
      release.view.status = 'releasing'
      delete release.view.finishedAt
      release.view.continuations = continuations
      for (const resource of resources) {
        const item = release.view.resources.find(({ id }) => id === this.id(resource))!
        item.status = 'pending'
      }
      this.releases.set(release.view.operationId, release)
      this.dependencies.logger.info('Notebook resource release committed', {
        ...scope,
        operationId: release.view.operationId,
        resourceCount: resources.length,
        retry: Boolean(retry)
      })
      const writer = releaseWriter
      const operation = withDataRootWrite(async () => {
        const drain = resources.filter(
          (resource) =>
            resource.group === 'operation' ||
            resource.group === 'reproduction' ||
            resource.group === 'batch'
        )
        const trees = resources.filter((resource) => !drain.includes(resource))
        const record = (outcomes: Awaited<ReturnType<typeof releaseNotebookResources>>): void => {
          for (const { resource, result } of outcomes) {
            release.results.set(resource.identity, result)
            const item = release.view.resources.find(({ id }) => id === this.id(resource))!
            Object.assign(item, {
              status: result.reaped && result.projection !== 'failed' ? 'released' : 'incomplete',
              processesTerminated: result.processesTerminated,
              networkClosed: result.networkClosed,
              temporaryResourcesRemoved: result.temporaryResourcesRemoved,
              projection: result.projection,
              error:
                result.error instanceof Error
                  ? result.error.message
                  : result.error === undefined
                    ? undefined
                    : String(result.error)
            })
          }
          this.dependencies.changed()
        }
        record(await releaseNotebookResources(drain))
        record(await releaseNotebookResources(trees))
        release.view.status = release.view.resources.every(({ status }) => status === 'released')
          ? 'released'
          : 'partial'
        release.view.finishedAt = Date.now()
      })
        .catch((error: unknown) => {
          this.dependencies.logger.error('Notebook resource release could not finish', {
            ...scope,
            operationId: release.view.operationId,
            error: error instanceof Error ? error.message : String(error)
          })
          release.view.status = 'partial'
          release.view.finishedAt = Date.now()
          for (const item of release.view.resources)
            if (item.status === 'pending') {
              item.status = 'incomplete'
              item.error = error instanceof Error ? error.message : String(error)
            }
        })
        .finally(() => {
          writer()
          releaseHold()
          this.complete(release)
          if (release.view.status === 'released') {
            release.resources = []
            release.results.clear()
            const key = keyFor(scope)
            if (this.confirmations.get(key)?.revision === release.view.revision)
              this.confirmations.delete(key)
          }
          this.dependencies.logger.info('Notebook resource release settled', {
            ...scope,
            operationId: release.view.operationId,
            status: release.view.status,
            incompleteCount: release.view.resources.filter(({ status }) => status === 'incomplete')
              .length
          })
          this.dependencies.changed()
        })
        .finally(() => {
          this.retainCompletedReleases()
          this.dependencies.changed()
        })
      this.dependencies.observe(scope, operation)
      this.dependencies.changed()
      return { view: this.view(release) }
    } catch (error) {
      releaseWriter?.()
      releaseHold()
      throw error
    }
  }
}
