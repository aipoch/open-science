import { describe, expect, it } from 'vitest'

import { formatEta, formatProgressLine, formatSpeed } from './download-progress'

describe('download-progress formatters', () => {
  it('formats speed with binary units', () => {
    expect(formatSpeed(0)).toBe('0 B/s')
    expect(formatSpeed(2_411_724)).toBe('2.3 MB/s')
  })

  it('formats ETA as compact minutes/seconds', () => {
    expect(formatEta(undefined)).toBeUndefined()
    expect(formatEta(45)).toBe('~45s')
    expect(formatEta(130)).toBe('~2m 10s')
    expect(formatEta(120)).toBe('~2m')
  })

  it('composes a downloading line with total known', () => {
    const line = formatProgressLine({
      phase: 'downloading',
      transferred: 47_400_000,
      total: 335_500_000,
      percent: 14,
      bytesPerSecond: 2_411_724,
      etaSeconds: 130,
      attempt: 0
    })
    expect(line).toContain('2.3 MB/s')
    expect(line).toContain('14%')
    expect(line).toContain('~2m 10s')
  })

  it('composes a downloading line when total unknown', () => {
    const line = formatProgressLine({
      phase: 'downloading',
      transferred: 47_400_000,
      bytesPerSecond: 2_411_724,
      attempt: 0
    })
    expect(line).toContain('downloaded')
    expect(line).not.toContain('%')
  })

  it('composes a reconnecting line with attempt number', () => {
    const line = formatProgressLine({
      phase: 'reconnecting',
      transferred: 47_400_000,
      bytesPerSecond: 0,
      attempt: 2
    })
    expect(line).toBe('Connection lost, resuming… (attempt 2)')
  })
})
