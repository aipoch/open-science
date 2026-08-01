import type { ConsoleMessage, Page } from 'playwright'

type ObservablePage = Pick<Page, 'on'>

class RendererFailureGate {
  private readonly failures: Error[] = []

  observe(page: ObservablePage): void {
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() === 'error') {
        this.failures.push(new Error(`[renderer console] ${message.text()}`))
      }
    })
    page.on('pageerror', (error: Error) => {
      this.failures.push(new Error(`[renderer pageerror] ${error.message}`, { cause: error }))
    })
  }

  assertNoFailures(): void {
    if (this.failures.length === 0) return
    throw new AggregateError(this.failures, 'Renderer emitted errors during Electron E2E.')
  }
}

export { RendererFailureGate }
