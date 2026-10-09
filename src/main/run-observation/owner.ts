import { createHash, randomUUID } from 'node:crypto'
import { isSensitiveDiagnosticKey, redactSensitiveText } from '../../shared/diagnostic-redaction'
import type { NotebookRunRecord } from '../../shared/notebook'
import {
  runObservationChangesRequestSchema,
  runObservationSelectionRequestSchema,
  runObservationSnapshotSchema,
  runObservationDemoViewingSchema,
  runObservationTargetSchema,
  type RunObservationArtifact,
  type RunObservationExecutionContext,
  type RunObservationChange,
  type RunObservationChanges,
  type RunObservationChangesRequest,
  type RunObservationHistory,
  type RunObservationIdentity,
  type RunObservationLog,
  type RunObservationPhase,
  type RunObservationSelection,
  type RunObservationSelectionRequest,
  type RunObservationSnapshot,
  type RunObservationTarget
} from '../../shared/run-observation'

/** Trusted adapter output, resolved from the exact operation/invocation, never Session recency. */
export type RunObservationSource = Readonly<{
  identity: RunObservationIdentity
  phase: RunObservationPhase
  run: NotebookRunRecord | null
  /** Only finalized, published Versions authorized for this viewer. No Artifact producer bypass. */
  artifacts: readonly RunObservationArtifact[]
  executionContext?: RunObservationExecutionContext
  /** Extra process-owned roots/credentials to redact; these values never enter the public DTO. */
  privatePaths?: readonly string[]
  secrets?: readonly string[]
}>
export type RunObservationDependencies = Readonly<{
  /** Must revalidate Project, Session and the caller's read capability; no write authority implied. */
  authorize(target: RunObservationTarget, viewer: RunObservationViewer): Promise<void>
  read(
    target: RunObservationTarget,
    viewer: RunObservationViewer
  ): Promise<RunObservationSource | undefined>
  now?: () => number
  limits?: Readonly<{
    logCharacters?: number
    historySnapshots?: number
    scopes?: number
    artifacts?: number
  }>
}>
/** Supplied by an authenticated transport, never accepted from untrusted request JSON. */
export type RunObservationViewer = Readonly<{ viewerId: string }>
export class RunObservationError extends Error {
  readonly name = 'RunObservationError'
  constructor(
    readonly code:
      'unavailable' | 'scope-mismatch' | 'cursor-expired' | 'step-mismatch' | 'closed' | 'capacity',
    message: string
  ) {
    super(message)
  }
}
type ScopeState = {
  fingerprint: string
  snapshots: RunObservationSnapshot[]
  snapshotCharacters: number[]
  selection?: RunObservationSelection
  selectionCharacters: number
  touchedAt: number
}
const selectors = ['operationId', 'executionInvocationId', 'runId'] as const
const identityFields = ['projectId', 'sessionId', ...selectors, 'environmentId'] as const
const keyOf = (target: RunObservationTarget, viewer: RunObservationViewer): string =>
  JSON.stringify([
    viewer.viewerId,
    target.projectId,
    target.sessionId,
    target.operationId ?? null,
    target.executionInvocationId ?? null,
    target.runId ?? null
  ])
const clone = <T>(value: T): T => structuredClone(value)
const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right)
const bound = (value: number | undefined, fallback: number, min: number, max: number): number =>
  value !== undefined && Number.isSafeInteger(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
const privatePathPattern =
  /(?:file:\/\/)?\/(?:Users|home|private|var|tmp|etc|opt|Applications|Volumes)\/[^\s"'<>]*/g
const windowsPathPattern = /\b[A-Za-z]:\\[^\s"'<>]+/g
const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const parseViewer = (viewer: RunObservationViewer): RunObservationViewer => {
  if (!viewer || !identityPattern.test(viewer.viewerId))
    throw new RunObservationError(
      'scope-mismatch',
      'An authenticated observation viewer is required.'
    )
  return { viewerId: viewer.viewerId }
}

function assertSource(target: RunObservationTarget, source: RunObservationSource): void {
  if (
    identityFields.some((field) => {
      const value = source.identity[field]
      return value !== undefined && !identityPattern.test(value)
    }) ||
    source.identity.projectId !== target.projectId ||
    source.identity.sessionId !== target.sessionId ||
    selectors.some((field) => target[field] && target[field] !== source.identity[field]) ||
    (source.run &&
      (source.identity.runId !== source.run.runId ||
        source.identity.executionInvocationId !== source.run.executionInvocationId))
  )
    throw new RunObservationError('scope-mismatch', 'Observation source does not match its scope.')
}

function redactor(source: RunObservationSource): (text: string) => string {
  const context = source.run?.frozenShellContext
  const paths = [
    ...(source.privatePaths ?? []),
    source.run?.cwdBefore,
    source.run?.cwdAfter,
    context?.cwd,
    context?.handoffDir,
    context?.runtimeRoot,
    context?.notebookSessionRoot,
    context?.inputRoot,
    ...(context?.protectedDirs ?? [])
  ].filter((value): value is string => typeof value === 'string' && value.length > 1)
  const secrets = [
    ...(source.secrets ?? []),
    ...Object.entries(context?.environment ?? {})
      .filter(([key]) => isSensitiveDiagnosticKey(key))
      .map(([, value]) => value)
  ].filter((value) => value.length > 0)
  return (text) => {
    let value = text
    // Replace known values before the generic policy, so an unlabeled echoed credential is covered.
    for (const secret of secrets) value = value.split(secret).join('[redacted]')
    for (const path of paths.sort((a, b) => b.length - a.length))
      value = value.split(path).join('[local path]')
    return redactSensitiveText(value)
      .replace(privatePathPattern, '[local path]')
      .replace(windowsPathPattern, '[local path]')
  }
}

function projectLog(
  raw: string,
  redact: (text: string) => string,
  limit: number,
  sourceTruncated: boolean
): RunObservationLog {
  // Notebook owns the durable log. The viewer retains a bounded tail, not a competing log store.
  const scanBudget = Math.max(limit * 4, 65536)
  let text = raw
  if (raw.length > scanBudget) {
    text = raw.slice(-scanBudget)
    // Do not expose the suffix of a credential whose assignment was cut at the sampling boundary.
    const newline = text.indexOf('\n')
    text = newline < 0 ? '' : text.slice(newline + 1)
  }
  const safe = redact(text)
  return {
    text: safe.slice(-limit),
    truncated: sourceTruncated || raw.length > scanBudget || safe.length > limit,
    redacted: safe !== text
  }
}

/** Read-only, bounded projection owner. It never executes, cancels, publishes or rewrites a Run. */
export class RunObservationOwner {
  private readonly scopes = new Map<string, ScopeState>()
  private readonly reads = new Map<string, Promise<unknown>>()
  private pendingReads = 0
  // Text is UTF-16 in V8; this bounds retained serialized payloads to roughly 16 MiB plus objects.
  private readonly characterBudget = 8 * 1024 * 1024
  private retainedCharacters = 0
  private readonly logLimit: number
  private readonly historyLimit: number
  private readonly scopeLimit: number
  private readonly artifactLimit: number
  private closed = false

  constructor(private readonly dependencies: RunObservationDependencies) {
    this.logLimit = bound(dependencies.limits?.logCharacters, 16384, 128, 65536)
    this.historyLimit = bound(dependencies.limits?.historySnapshots, 16, 2, 128)
    this.scopeLimit = bound(dependencies.limits?.scopes, 32, 1, 128)
    this.artifactLimit = bound(dependencies.limits?.artifacts, 128, 1, 1000)
  }

  private assertOpen(): void {
    if (this.closed) throw new RunObservationError('closed', 'Observation owner is closed.')
  }

  private dropScope(key: string): void {
    const state = this.scopes.get(key)
    if (!state) return
    this.retainedCharacters -=
      state.snapshotCharacters.reduce((sum, size) => sum + size, 0) + state.selectionCharacters
    this.scopes.delete(key)
  }

  private prune(protectedKey: string): void {
    while (this.retainedCharacters > this.characterBudget) {
      const oldest = [...this.scopes.values()]
        .filter((state) => state.snapshots.length > 1)
        .sort((left, right) => left.snapshots[0].observedAt - right.snapshots[0].observedAt)[0]
      if (oldest) {
        oldest.snapshots.shift()
        this.retainedCharacters -= oldest.snapshotCharacters.shift()!
        continue
      }
      const victim = [...this.scopes]
        .filter(([key]) => key !== protectedKey)
        .sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0]
      if (!victim) break
      this.dropScope(victim[0])
    }
  }

  private async serial<T>(
    target: RunObservationTarget,
    viewer: RunObservationViewer,
    operation: () => Promise<T>
  ): Promise<T> {
    this.assertOpen()
    if (this.pendingReads >= 256)
      throw new RunObservationError('capacity', 'Too many observation reads are pending.')
    this.pendingReads++
    const key = keyOf(target, viewer)
    const previous = this.reads.get(key)
    const task = (previous ?? Promise.resolve()).catch(() => undefined).then(operation)
    this.reads.set(key, task)
    try {
      return await task
    } finally {
      this.pendingReads--
      if (this.reads.get(key) === task) this.reads.delete(key)
    }
  }

  private async authorize(
    target: RunObservationTarget,
    viewer: RunObservationViewer
  ): Promise<void> {
    this.assertOpen()
    try {
      await this.dependencies.authorize(clone(target), clone(viewer))
      this.assertOpen()
    } catch (error) {
      this.dropScope(keyOf(target, viewer))
      throw error
    }
  }

  private async refresh(
    target: RunObservationTarget,
    viewer: RunObservationViewer
  ): Promise<ScopeState> {
    await this.authorize(target, viewer)
    const source = clone(await this.dependencies.read(clone(target), clone(viewer)))
    // Revocation or Session deletion may win while an asynchronous repository read is in flight.
    await this.authorize(target, viewer)
    if (!source) {
      this.dropScope(keyOf(target, viewer))
      throw new RunObservationError('unavailable', 'The selected execution is unavailable.')
    }
    const key = keyOf(target, viewer)
    try {
      assertSource(target, source)
    } catch (error) {
      this.dropScope(key)
      throw error
    }
    let state = this.scopes.get(key)
    const previous = state?.snapshots.at(-1)
    if (
      previous &&
      identityFields.some(
        (field) => previous.identity[field] && previous.identity[field] !== source.identity[field]
      )
    ) {
      this.dropScope(key)
      throw new RunObservationError('scope-mismatch', 'The selected execution identity changed.')
    }
    const redact = redactor(source)
    const run = source.run
    const artifacts = source.artifacts.slice(0, this.artifactLimit).map((artifact) => {
      if (
        !identityPattern.test(artifact.versionId) ||
        (artifact.producerRunId && artifact.producerRunId !== source.identity.runId)
      )
        throw new RunObservationError('scope-mismatch', 'An output belongs to another execution.')
      return {
        ...(artifact.artifactId ? { artifactId: artifact.artifactId } : {}),
        versionId: artifact.versionId,
        name: redact(artifact.name).slice(0, 512),
        ...(artifact.mimeType ? { mimeType: artifact.mimeType.slice(0, 128) } : {}),
        ...(artifact.producerRunId ? { producerRunId: artifact.producerRunId } : {}),
        ...(artifact.checksum ? { checksum: artifact.checksum } : {}),
        ...(artifact.sizeBytes !== undefined ? { sizeBytes: artifact.sizeBytes } : {})
      }
    })
    const projection = {
      identity: Object.fromEntries(
        identityFields.flatMap((field) =>
          source.identity[field] === undefined ? [] : [[field, source.identity[field]]]
        )
      ) as RunObservationIdentity,
      phase: source.phase,
      stepId: run
        ? `run:${run.runId}`
        : source.identity.operationId
          ? `operation:${source.identity.operationId}`
          : `execution:${source.identity.executionInvocationId ?? source.identity.runId}`,
      run: run
        ? {
            runId: run.runId,
            ...(run.executionInvocationId
              ? { executionInvocationId: run.executionInvocationId }
              : {}),
            kernelKind: run.kernelKind,
            status: run.status,
            startedAt: run.startedAt,
            ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
            ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
            logs: {
              stdout: projectLog(run.text.stdout, redact, this.logLimit, !!run.truncated),
              stderr: projectLog(run.text.stderr, redact, this.logLimit, !!run.truncated),
              traceback: projectLog(run.text.traceback, redact, this.logLimit, !!run.truncated)
            }
          }
        : null,
      artifacts,
      artifactsTruncated: source.artifacts.length > this.artifactLimit,
      executionContext: {
        purpose: source.executionContext?.purpose ?? 'unknown',
        ...(source.executionContext?.profileName !== undefined
          ? { profileName: redact(source.executionContext.profileName).slice(0, 160) }
          : {}),
        conditionChanges: (source.executionContext?.conditionChanges ?? [])
          .slice(0, 32)
          .map((text) => redact(text).slice(0, 2048)),
        ...(source.executionContext?.purpose === 'offline-demo' &&
        source.executionContext.demoViewing
          ? {
              demoViewing: runObservationDemoViewingSchema.parse(
                source.executionContext.demoViewing
              )
            }
          : {})
      }
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(projection)).digest('hex')
    const now = Math.max((this.dependencies.now ?? Date.now)(), previous?.observedAt ?? 0)
    if (state?.fingerprint === fingerprint) {
      state.touchedAt = now
      return state
    }
    const snapshot = runObservationSnapshotSchema.parse({
      ...projection,
      cursor: {
        epoch: previous?.cursor.epoch ?? randomUUID(),
        sequence: (previous?.cursor.sequence ?? -1) + 1
      },
      observedAt: now
    })
    if (!state) {
      if (this.scopes.size >= this.scopeLimit) {
        const oldest = [...this.scopes].sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0]
        if (oldest) this.dropScope(oldest[0])
      }
      state = {
        fingerprint,
        snapshots: [],
        snapshotCharacters: [],
        selectionCharacters: 0,
        touchedAt: now
      }
      this.scopes.set(key, state)
    }
    state.fingerprint = fingerprint
    state.touchedAt = now
    state.snapshots.push(snapshot)
    const characters = JSON.stringify(snapshot).length
    state.snapshotCharacters.push(characters)
    this.retainedCharacters += characters
    if (state.snapshots.length > this.historyLimit) {
      state.snapshots.shift()
      this.retainedCharacters -= state.snapshotCharacters.shift()!
    }
    this.prune(key)
    return state
  }

  async snapshot(
    input: RunObservationTarget,
    context: RunObservationViewer
  ): Promise<RunObservationSnapshot> {
    const target = runObservationTargetSchema.parse(input)
    const viewer = parseViewer(context)
    return this.serial(target, viewer, async () =>
      clone((await this.refresh(target, viewer)).snapshots.at(-1)!)
    )
  }

  async history(
    input: RunObservationTarget,
    context: RunObservationViewer
  ): Promise<RunObservationHistory> {
    const target = runObservationTargetSchema.parse(input)
    const viewer = parseViewer(context)
    return this.serial(target, viewer, async () => {
      const state = await this.refresh(target, viewer)
      return clone({
        coverage: 'process-local' as const,
        truncated: state.snapshots[0].cursor.sequence > 0,
        snapshots: state.snapshots
      })
    })
  }

  async changes(
    input: RunObservationChangesRequest,
    context: RunObservationViewer
  ): Promise<RunObservationChanges> {
    const request = runObservationChangesRequestSchema.parse(input)
    const { cursor, ...target } = request
    const viewer = parseViewer(context)
    return this.serial(target, viewer, async () => {
      const state = await this.refresh(target, viewer)
      const latest = state.snapshots.at(-1)!
      const reason =
        cursor.epoch !== latest.cursor.epoch
          ? 'epoch-changed'
          : cursor.sequence > latest.cursor.sequence
            ? 'cursor-ahead'
            : cursor.sequence < state.snapshots[0].cursor.sequence
              ? 'cursor-expired'
              : undefined
      if (reason) return clone({ kind: 'resync', reason, snapshot: latest })
      const index = state.snapshots.findIndex(
        (snapshot) => snapshot.cursor.sequence === cursor.sequence
      )
      const changes: RunObservationChange[] = []
      for (let position = index + 1; position < state.snapshots.length; position++) {
        const before = state.snapshots[position - 1]
        const after = state.snapshots[position]
        changes.push({
          cursor: after.cursor,
          observedAt: after.observedAt,
          ...Object.fromEntries(
            (
              [
                'identity',
                'phase',
                'stepId',
                'run',
                'artifacts',
                'artifactsTruncated',
                'executionContext'
              ] as const
            ).flatMap((field) => (same(before[field], after[field]) ? [] : [[field, after[field]]]))
          )
        })
      }
      return clone({ kind: 'delta', from: cursor, cursor: latest.cursor, changes })
    })
  }

  async select(
    input: RunObservationSelectionRequest,
    context: RunObservationViewer
  ): Promise<RunObservationSelection> {
    const { cursor, stepId, ...target } = runObservationSelectionRequestSchema.parse(input)
    const viewer = parseViewer(context)
    return this.serial(target, viewer, async () => {
      await this.authorize(target, viewer)
      const state = this.scopes.get(keyOf(target, viewer))
      const snapshot = state?.snapshots.find(
        (item) => item.cursor.epoch === cursor.epoch && item.cursor.sequence === cursor.sequence
      )
      if (!state || !snapshot)
        throw new RunObservationError(
          'cursor-expired',
          'The selected evidence is no longer retained.'
        )
      if (snapshot.stepId !== stepId)
        throw new RunObservationError(
          'step-mismatch',
          'The selected step does not match this cursor.'
        )
      const selection = {
        selectionId: randomUUID(),
        identity: snapshot.identity,
        cursor: snapshot.cursor,
        stepId,
        selectedAt: (this.dependencies.now ?? Date.now)(),
        snapshot
      }
      state.selection = clone(selection)
      this.retainedCharacters -= state.selectionCharacters
      state.selectionCharacters = JSON.stringify(selection).length
      this.retainedCharacters += state.selectionCharacters
      this.prune(keyOf(target, viewer))
      return clone(selection)
    })
  }

  async selection(
    input: RunObservationTarget,
    context: RunObservationViewer
  ): Promise<RunObservationSelection | null> {
    const target = runObservationTargetSchema.parse(input)
    const viewer = parseViewer(context)
    return this.serial(target, viewer, async () => {
      await this.authorize(target, viewer)
      return clone(this.scopes.get(keyOf(target, viewer))?.selection ?? null)
    })
  }

  /** Quiescing revokes readers and selections; it has no effect on the underlying execution. */
  close(): void {
    this.closed = true
    this.scopes.clear()
    this.retainedCharacters = 0
  }
}
