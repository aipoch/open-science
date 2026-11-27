import { fork } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { forkSpeechProcess } from './speech-client.js'

vi.mock('node:child_process', async () => ({
  ...(await vi.importActual<typeof import('node:child_process')>('node:child_process')),
  fork: vi.fn()
}))

describe('forkSpeechProcess', () => {
  afterEach(() => vi.clearAllMocks())

  it('hides the narration worker console on Windows', () => {
    const child = { pid: 1234 } as ReturnType<typeof fork>
    vi.mocked(fork).mockReturnValue(child)

    forkSpeechProcess()

    expect(fork).toHaveBeenCalledWith(
      expect.any(String),
      [],
      expect.objectContaining({ windowsHide: true })
    )
  })
})
