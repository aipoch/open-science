import type { App } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import type { AcpRuntime } from './runtime'
import { installAgentShutdownGuard } from './shutdown-guard'

// Captures registered app event handlers so the will-quit teardown can be invoked without Electron.
const createFakeApp = (): {
  on: App['on']
  emit: (event: string) => void
} => {
  const handlers = new Map<string, () => void>()

  return {
    on: ((event: string, handler: () => void) => {
      handlers.set(event, handler)
    }) as App['on'],
    emit: (event: string) => handlers.get(event)?.()
  }
}

describe('installAgentShutdownGuard', () => {
  it('shuts the runtime down when the app is quitting', () => {
    const app = createFakeApp()
    const shutdown = vi.fn()
    installAgentShutdownGuard(app, { shutdown } as unknown as Pick<AcpRuntime, 'shutdown'>)

    expect(shutdown).not.toHaveBeenCalled()

    app.emit('will-quit')

    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it('does not shut the runtime down before quit is committed', () => {
    const app = createFakeApp()
    const shutdown = vi.fn()
    installAgentShutdownGuard(app, { shutdown } as unknown as Pick<AcpRuntime, 'shutdown'>)

    // before-quit can be cancelled (e.g. the migration guard), so it must not trigger the teardown.
    app.emit('before-quit')

    expect(shutdown).not.toHaveBeenCalled()
  })
})
