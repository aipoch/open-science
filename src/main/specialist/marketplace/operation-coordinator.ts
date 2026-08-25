export class MarketplaceOperationCoordinator {
  private tail: Promise<void> = Promise.resolve()

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation)
    this.tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}
