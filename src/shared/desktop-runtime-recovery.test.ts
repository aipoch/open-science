import { describe, expect, it } from 'vitest'
import {
  DesktopRuntimeDisconnectedError,
  isDesktopRuntimeConnectionError
} from './desktop-runtime-recovery'

describe('desktop connection failure classification', () => {
  it('groups dependent connection failures by explicit code without matching their text', () => {
    for (const message of ['Read failed', 'Write request not submitted', 'Lost native operation'])
      expect(isDesktopRuntimeConnectionError(new DesktopRuntimeDisconnectedError(message))).toBe(
        true
      )
    expect(isDesktopRuntimeConnectionError({ code: 'desktop-runtime-disconnected' })).toBe(true)
  })

  it('retains independent business and real save errors, including wrapped connection causes', () => {
    expect(isDesktopRuntimeConnectionError(new Error('Desktop runtime is disconnected.'))).toBe(
      false
    )
    expect(
      isDesktopRuntimeConnectionError(
        new Error('Saving the draft failed.', {
          cause: new DesktopRuntimeDisconnectedError()
        })
      )
    ).toBe(false)
    expect(isDesktopRuntimeConnectionError({ code: 'database-write-failed' })).toBe(false)
  })
})
