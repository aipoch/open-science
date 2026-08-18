type Operation<Result> = () => Promise<Result>

// Keeps Session persistence ordered at its real authority scopes. Scoped operations may overlap when
// they share no Project or Session identity, while a global operation forms an exclusive barrier that
// waits for every earlier scope and blocks every later one until it settles.
class SessionPersistenceOperationScheduler {
  private globalTail: Promise<void> = Promise.resolve()
  private readonly scopeTails = new Map<string, Promise<void>>()

  runProject<Result>(projectId: string, operation: Operation<Result>): Promise<Result> {
    return this.runScoped([projectScope(projectId)], operation)
  }

  runSession<Result>(
    projectId: string,
    sessionId: string,
    operation: Operation<Result>
  ): Promise<Result> {
    return this.runScoped([projectScope(projectId), sessionScope(sessionId)], operation)
  }

  runSessionIdentity<Result>(sessionId: string, operation: Operation<Result>): Promise<Result> {
    return this.runScoped([sessionScope(sessionId)], operation)
  }

  runManifest<Result>(operation: Operation<Result>): Promise<Result> {
    return this.runScoped([MANIFEST_SCOPE], operation)
  }

  runGlobal<Result>(operation: Operation<Result>): Promise<Result> {
    const predecessors = new Set([this.globalTail, ...this.scopeTails.values()])
    const run = Promise.all(predecessors).then(operation)
    this.globalTail = settledTail(run)
    return run
  }

  private runScoped<Result>(
    scopes: readonly string[],
    operation: Operation<Result>
  ): Promise<Result> {
    const uniqueScopes = [...new Set(scopes)]
    const predecessors = new Set([
      this.globalTail,
      ...uniqueScopes.flatMap((scope) => {
        const tail = this.scopeTails.get(scope)
        return tail ? [tail] : []
      })
    ])
    const run = Promise.all(predecessors).then(operation)
    const tail = settledTail(run)
    for (const scope of uniqueScopes) this.scopeTails.set(scope, tail)
    void tail.then(() => {
      for (const scope of uniqueScopes) {
        if (this.scopeTails.get(scope) === tail) this.scopeTails.delete(scope)
      }
    })
    return run
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
