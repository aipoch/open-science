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
    expect(parseWebModeOptions(['electron', '--open-science-headless'], {})).toMatchObject({
      enabled: true,
      headless: true
    })
  })

  it('rejects invalid ports', () => {
    expect(() => parseWebModeOptions(['electron', '--serve=nope'], {})).toThrow(
      'Invalid Open-Science web port'
    )
    expect(() => parseWebModeOptions(['electron', '--serve=44100abc'], {})).toThrow(
      'Invalid Open-Science web port'
    )
    expect(() => parseWebModeOptions(['electron', '--serve='], {})).toThrow(
      'Invalid Open-Science web port'
    )
    expect(() => parseWebModeOptions(['electron'], { OPEN_SCIENCE_WEB_PORT: '44100xyz' })).toThrow(
      'Invalid Open-Science web port'
    )
  })

  it('allocates a port for desktop-owned backends while keeping the standalone default', () => {
    expect(parseWebModeOptions(['node', '--desktop', '--serve'], {})).toEqual({
      enabled: true,
      headless: false,
      port: 0
    })
    expect(parseWebModeOptions(['node', '--serve'], {}).port).toBe(44100)
    expect(parseWebModeOptions(['node', '--open-science-headless'], {}).port).toBe(44100)
  })

  it('preserves explicit desktop ports and validates them without falling back', () => {
    const argv = ['node', '--desktop', '--serve']
    expect(parseWebModeOptions(argv, { OPEN_SCIENCE_WEB_PORT: ' 44200 ' }).port).toBe(44200)
    expect(parseWebModeOptions(argv, { OPEN_SCIENCE_WEB_PORT: ' ' }).port).toBe(0)
    expect(
      parseWebModeOptions(['node', '--desktop', '--serve=44300'], {
        OPEN_SCIENCE_WEB_PORT: '44200'
      }).port
    ).toBe(44300)
    expect(parseWebModeOptions(['node', '--desktop', '--serve=0'], {}).port).toBe(0)
    expect(() => parseWebModeOptions(argv, { OPEN_SCIENCE_WEB_PORT: 'invalid' })).toThrow(
      'Invalid Open-Science web port'
    )
  })
})
