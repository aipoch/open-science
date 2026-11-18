import { describe, expect, it, vi } from 'vitest'

import { PptxEditError } from '../../shared/pptx-edit'
import type { ApplicationCallerLease } from '../application-command-router'
import { PptxEditSessionError } from './edit-sessions'
import { createPptxEditCommands } from './application-commands'

const createLease = (): ApplicationCallerLease & { abort: () => void } => {
  const controller = new AbortController()
  return {
    signal: controller.signal,
    isCurrent: () => !controller.signal.aborted,
    abort: () => controller.abort()
  } as unknown as ApplicationCallerLease & { abort: () => void }
}

const invocation = <Args extends readonly unknown[]>(
  args: Args,
  lease = createLease(),
  surface = 'electron'
): never => ({ callerContext: { surface }, callerLease: lease, args }) as never

const setup = (): {
  sessions: Record<string, ReturnType<typeof vi.fn>>
  commands: ReturnType<typeof createPptxEditCommands>
  onSaved: ReturnType<typeof vi.fn>
} => {
  const sessions = {
    open: vi.fn(),
    apply: vi.fn(),
    save: vi.fn(),
    close: vi.fn(),
    closeOwner: vi.fn(),
    identityOf: vi.fn()
  }
  const onSaved = vi.fn()
  const commands = createPptxEditCommands({
    sessions: sessions as never,
    withDataRootWrite: (write) => write(),
    onSaved
  })
  return { sessions, commands, onSaved }
}

describe('createPptxEditCommands', () => {
  it('wraps session results and maps known failures to stable codes', async () => {
    const { sessions, commands } = setup()
    sessions.open.mockReturnValueOnce({ sessionId: 's1' })
    await expect(commands.open(invocation([{}] as const))).resolves.toEqual({
      ok: true,
      value: { sessionId: 's1' }
    })

    sessions.apply.mockImplementationOnce(() => {
      throw new PptxEditSessionError('SESSION_NOT_FOUND', 'gone')
    })
    await expect(commands.apply(invocation([{}] as const))).resolves.toMatchObject({
      ok: false,
      error: { code: 'SESSION_NOT_FOUND' }
    })

    sessions.apply.mockImplementationOnce(() => {
      throw new PptxEditError('OUTPUT_TOO_LARGE', 'big')
    })
    await expect(commands.apply(invocation([{}] as const))).resolves.toMatchObject({
      ok: false,
      error: { code: 'TOO_LARGE' }
    })

    sessions.apply.mockImplementationOnce(() => {
      throw new PptxEditError('SHAPE_NOT_FOUND', 'missing')
    })
    await expect(commands.apply(invocation([{}] as const))).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_REJECTED' }
    })
  })

  it('rethrows unexpected errors instead of hiding them', async () => {
    const { sessions, commands } = setup()
    sessions.open.mockImplementationOnce(() => {
      throw new TypeError('unexpected')
    })
    await expect(commands.open(invocation([{}] as const))).rejects.toThrow('unexpected')
  })

  it('rejects non-desktop callers and stale leases before touching sessions', async () => {
    const { sessions, commands } = setup()
    await expect(commands.open(invocation([{}] as const, createLease(), 'web'))).rejects.toThrow(
      /desktop app/
    )
    const stale = createLease()
    stale.abort()
    await expect(commands.open(invocation([{}] as const, stale))).rejects.toThrow(/no longer valid/)
    expect(sessions.open).not.toHaveBeenCalled()
  })

  it('closes every session of a caller when its lease aborts', async () => {
    const { sessions, commands } = setup()
    const lease = createLease()
    sessions.open.mockReturnValue({ sessionId: 's1' })
    await commands.open(invocation([{}] as const, lease))
    await commands.open(invocation([{}] as const, lease))
    lease.abort()
    expect(sessions.closeOwner).toHaveBeenCalledTimes(1)
    expect(sessions.closeOwner).toHaveBeenCalledWith(lease)
  })

  it('saves inside the data-root write and reports the saved result', async () => {
    const { sessions, commands, onSaved } = setup()
    const saved = { kind: 'noop' }
    sessions.save.mockResolvedValueOnce(saved)
    const request = { sessionId: 's1' }
    await expect(commands.save(invocation([request] as const))).resolves.toEqual({
      ok: true,
      value: saved
    })
    expect(onSaved).toHaveBeenCalledWith(request, saved)
  })

  it('ignores a close without a session id', async () => {
    const { sessions, commands } = setup()
    await commands.close(invocation([undefined] as unknown as readonly [string]))
    await commands.close(invocation(['s1'] as const))
    expect(sessions.close).toHaveBeenCalledTimes(1)
  })
})
