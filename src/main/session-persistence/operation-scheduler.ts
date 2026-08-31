type Operation<Result> = () => Promise<Result>
type ScopedOperation<Result> = (scope: SessionPersistenceOperationScope) => Promise<Result>
type SessionIdentityRunner = <Result>(
  sessionIds: readonly string[],
  operation: Operation<Result>
) => Promise<Result>

class SessionPersistenceOperationScope {
  constructor(private readonly runWithSessionIdentities: SessionIdentityRunner) {}

  runSessionIdentities<Result>(
    sessionIds: readonly string[],
    operation: Operation<Result>
  ): Promise<Result> {
    return this.runWithSessionIdentities(sessionIds, operation)
  }
}

// Keeps Session persistence ordered at its real authority scopes. Scoped operations may overlap when
// they share no Project or Session identity, while a global operation forms an exclusive barrier that
// waits for every earlier scope and blocks every later one until it settles.
class SessionPersistenceOperationScheduler {
  private globalTail: Promise<void> = Promise.resolve()
  private generation = 0
  private readonly scopeTails = new Map<string, Map<number, Promise<void>>>()

  runProject<Result>(projectId: string, operation: ScopedOperation<Result>): Promise<Result> {
    return this.runScoped([projectScope(projectId)], operation)
  }

  runSession<Result>(
    projectId: string,
    sessionId: string,
    operation: ScopedOperation<Result>
  ): Promise<Result> {
    return this.runScoped([projectScope(projectId), sessionScope(sessionId)], operation)
  }

  runSessionThenGlobal<Result, FinalResult>(
    projectId: string,
    sessionId: string,
    operation: ScopedOperation<Result>,
    globalOperation: (result: Result) => Promise<FinalResult>
  ): Promise<FinalResult> {
    return this.runSession(projectId, sessionId, operation).then((result) =>
      this.runGlobal(() => globalOperation(result))
    )
  }

  runSessionThenGlobalIfNeeded<Result, FinalResult>(
    projectId: string,
    sessionId: string,
    operation: ScopedOperation<Result | undefined>,
    globalOperation: (result: Result) => Promise<FinalResult>
  ): Promise<FinalResult | undefined> {
    return this.runSession(projectId, sessionId, operation).then((result) =>
      result === undefined ? undefined : this.runGlobal(() => globalOperation(result))
    )
  }

  runSessionIdentity<Result>(
    sessionId: string,
    operation: ScopedOperation<Result>
  ): Promise<Result> {
    return this.runSessionIdentities([sessionId], operation)
  }

  runSessionIdentities<Result>(
    sessionIds: readonly string[],
    operation: ScopedOperation<Result>
  ): Promise<Result> {
    return this.runScoped(sessionIds.map(sessionScope), operation)
  }

  runManifest<Result>(operation: ScopedOperation<Result>): Promise<Result> {
    return this.runScoped([MANIFEST_SCOPE], operation)
  }

  runGlobal<Result>(operation: Operation<Result>): Promise<Result> {
    const predecessors = new Set([
      this.globalTail,
      ...[...this.scopeTails.values()].flatMap((tails) => [...tails.values()])
    ])
    const run = Promise.all(predecessors).then(operation)
    this.globalTail = settledTail(run)
    this.generation += 1
    return run
  }

  private runScoped<Result>(
    scopes: readonly string[],
    operation: ScopedOperation<Result>
  ): Promise<Result> {
    const generation = this.generation
    const uniqueScopes = [...new Set(scopes)]
    const predecessors = new Set([
      this.globalTail,
      ...uniqueScopes.flatMap((scope) => {
        const tail = this.scopeTails.get(scope)?.get(generation)
        return tail ? [tail] : []
      })
    ])
    const heldScopes = new Set(uniqueScopes)
    const operationScope = new SessionPersistenceOperationScope((sessionIds, nestedOperation) => {
      const additionalSessionIds = sessionIds.filter(
        (sessionId) => !heldScopes.has(sessionScope(sessionId))
      )
      return this.runNestedSessionIdentities(generation, additionalSessionIds, nestedOperation)
    })
    const run = Promise.all(predecessors).then(() => operation(operationScope))
    const tail = settledTail(run)
    this.recordScopeTail(uniqueScopes, generation, tail)
    return run
  }

  // A running scoped operation may extend its identity set. It stays in its original generation so
  // a later global barrier cannot become both its predecessor and its dependent.
  private runNestedSessionIdentities<Result>(
    generation: number,
    sessionIds: readonly string[],
    operation: Operation<Result>
  ): Promise<Result> {
    const uniqueScopes = [...new Set(sessionIds.map(sessionScope))]
    const predecessors = new Set(
      uniqueScopes.flatMap((scope) => {
        const tail = this.scopeTails.get(scope)?.get(generation)
        return tail ? [tail] : []
      })
    )
    const run = Promise.all(predecessors).then(operation)
    const tail = settledTail(run)
    this.recordScopeTail(uniqueScopes, generation, tail)
    return run
  }

  private recordScopeTail(
    scopes: readonly string[],
    generation: number,
    tail: Promise<void>
  ): void {
    for (const scope of scopes) {
      const tails = this.scopeTails.get(scope) ?? new Map<number, Promise<void>>()
      tails.set(generation, tail)
      this.scopeTails.set(scope, tails)
    }
    void tail.then(() => {
      for (const scope of scopes) {
        const tails = this.scopeTails.get(scope)
        if (tails?.get(generation) !== tail) continue
        tails.delete(generation)
        if (tails.size === 0) this.scopeTails.delete(scope)
      }
    })
  }
}

const MANIFEST_SCOPE = 'manifest'
const projectScope = (projectId: string): string => `project\0${projectId}`
const sessionScope = (sessionId: string): string => `session\0${sessionId}`
const settledTail = (operation: Promise<unknown>): Promise<void> =>
  operation.then(
    () => undefined,
    () => undefined
  )

export { SessionPersistenceOperationScheduler }
