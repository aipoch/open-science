import { describe, expect, it } from 'vitest'

import { parseWebModeOptions } from './options'

describe('parseWebModeOptions', () => {
  it('is disabled by default', () => {
    expect(parseWebModeOptions(['electron'], {})).toEqual({
      enabled: false,
      headless: false,
      port: 44100
    })
  })

  it('supports serve, explicit ports, environment ports, and headless mode', () => {
    expect(parseWebModeOptions(['electron', '--serve'], {}).enabled).toBe(true)
    expect(parseWebModeOptions(['electron', '--serve=0'], {}).port).toBe(0)
    expect(parseWebModeOptions(['electron'], { OPEN_SCIENCE_WEB_PORT: '44200' }).port).toBe(44200)
    expect(parseWebModeOptions(['electron', '--headless'], {})).toMatchObject({
      enabled: true,
      headless: true
    })
  })

  it('rejects invalid ports', () => {
    expect(() => parseWebModeOptions(['electron', '--serve=nope'], {})).toThrow(
      'Invalid Open Science web port'
    )
  })
})
