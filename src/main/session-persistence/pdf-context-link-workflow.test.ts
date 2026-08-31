import { describe, expect, it, vi } from 'vitest'

import { linkPdfContextWithCapability } from './pdf-context-link-workflow'

type Context = Readonly<{ revision: number; pdf: string | undefined }>
type WorkflowOptions = Parameters<typeof linkPdfContextWithCapability<Context>>[0]

const run = (
  overrides: Partial<WorkflowOptions> = {}
): Readonly<{ options: WorkflowOptions; result: Promise<Context> }> => {
  const previous: Context = { revision: 2, pdf: undefined }
  const linked: Context = { revision: 3, pdf: 'paper.pdf' }
  const options = {
    read: vi.fn(async () => previous),
    link: vi.fn(async () => ({ context: linked, changed: true })),
    revisionOf: (context: Context) => context.revision,
    enable: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    onRollbackError: vi.fn(),
    ...overrides
  }
  return { options, result: linkPdfContextWithCapability(options) }
}

describe('linkPdfContextWithCapability', () => {
  it('returns the linked context after the capability is enabled', async () => {
    const { options, result } = run()

    await expect(result).resolves.toEqual({ revision: 3, pdf: 'paper.pdf' })
    expect(options.rollback).not.toHaveBeenCalled()
  })

  it('rolls back the exact linked revision when capability mounting fails', async () => {
    const mountError = new Error('mount failed')
    const { options, result } = run({ enable: vi.fn(async () => Promise.reject(mountError)) })

    await expect(result).rejects.toBe(mountError)
    expect(options.rollback).toHaveBeenCalledWith(
      { revision: 3, pdf: 'paper.pdf' },
      { revision: 2, pdf: undefined }
    )
  })

  it('does not roll back when linking made no persistent change', async () => {
    const unchanged: Context = { revision: 2, pdf: undefined }
    const { options, result } = run({
      link: vi.fn(async () => ({ context: unchanged, changed: false })),
      enable: vi.fn(async () => Promise.reject(new Error('mount failed')))
    })

    await expect(result).rejects.toThrow('mount failed')
    expect(options.rollback).not.toHaveBeenCalled()
  })

  it('does not roll back a concurrent link that this request only observed', async () => {
    const concurrentlyLinked: Context = { revision: 3, pdf: 'paper.pdf' }
    const { options, result } = run({
      link: vi.fn(async () => ({ context: concurrentlyLinked, changed: false })),
      enable: vi.fn(async () => Promise.reject(new Error('mount failed')))
    })

    await expect(result).rejects.toThrow('mount failed')
    expect(options.rollback).not.toHaveBeenCalled()
  })

  it('preserves the mount failure when a concurrent change prevents rollback', async () => {
    const mountError = new Error('mount failed')
    const rollbackError = new Error('revision conflict')
    const { options, result } = run({
      enable: vi.fn(async () => Promise.reject(mountError)),
      rollback: vi.fn(async () => Promise.reject(rollbackError))
    })

    await expect(result).rejects.toBe(mountError)
    expect(options.onRollbackError).toHaveBeenCalledWith(rollbackError)
  })
})
