import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('./pdf-worker-cancellation.js', import.meta.url), 'utf8')
describe('PDF worker cancellation', () => {
  it('handles only the expected rejection after its worker receives Terminate', () => {
    const listeners = new Map<string, (event: unknown) => void>()
    class WorkerScope {
      addEventListener = (name: string, handler: (event: unknown) => void): void => {
        listeners.set(name, handler)
      }
    }
    runInNewContext(source, {
      globalThis: new WorkerScope(),
      WorkerGlobalScope: WorkerScope,
      Error
    })
    const cancellation = { reason: new Error('Worker was terminated'), preventDefault: vi.fn() }
    listeners.get('unhandledrejection')!(cancellation)
    expect(cancellation.preventDefault).not.toHaveBeenCalled()
    listeners.get('message')!({ data: { action: 'Terminate' } })
    listeners.get('unhandledrejection')!(cancellation)
    expect(cancellation.preventDefault).toHaveBeenCalledOnce()
    const failure = { reason: new Error('Invalid PDF structure'), preventDefault: vi.fn() }
    listeners.get('unhandledrejection')!(failure)
    expect(failure.preventDefault).not.toHaveBeenCalled()
  })
  it('never installs cancellation handling on the renderer during a fake-worker fallback', () => {
    const addEventListener = vi.fn()
    runInNewContext(source, { globalThis: { addEventListener }, Error })
    expect(addEventListener).not.toHaveBeenCalled()
  })
})
