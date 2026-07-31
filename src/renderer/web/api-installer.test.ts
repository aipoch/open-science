import { describe, expect, it, vi } from 'vitest'
import { WEB_INVOKE_CHANNELS } from '../../shared/web-api-map.generated'
import { installWebInvokeChannels } from './api-installer'

describe('installWebInvokeChannels', () => {
  it('installs a rejecting stub for a real restricted Web API channel', async () => {
    const api: Record<string, unknown> = {}
    const createInvoker = vi.fn()

    installWebInvokeChannels(
      api,
      WEB_INVOKE_CHANNELS,
      new Set(),
      new Set(['runtime:set-selection']),
      createInvoker
    )

    const setSelection = (api.runtime as { setSelection: (...args: unknown[]) => Promise<unknown> })
      .setSelection
    await expect(setSelection({ language: 'python', interpreter: '/tmp/python' })).rejects.toThrow(
      'This action is only available in the local desktop app (runtime:set-selection).'
    )
    expect(createInvoker).not.toHaveBeenCalled()
  })
})
