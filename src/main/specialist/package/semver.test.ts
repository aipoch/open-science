import { describe, expect, it } from 'vitest'

import { compareSemver } from './semver'

describe('compareSemver', () => {
  it('orders major, minor, and patch versions', () => {
    expect(compareSemver('1.0.0', '2.0.0')).toBe(-1)
    expect(compareSemver('2.1.0', '2.0.9')).toBe(1)
    expect(compareSemver('2.1.1', '2.1.0')).toBe(1)
    expect(compareSemver('2.1.1', '2.1.1')).toBe(0)
  })

  it('follows SemVer prerelease precedence', () => {
    const precedence = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0'
    ]

    for (let index = 0; index < precedence.length - 1; index += 1) {
      expect(compareSemver(precedence[index], precedence[index + 1])).toBe(-1)
      expect(compareSemver(precedence[index + 1], precedence[index])).toBe(1)
    }
  })

  it('orders numeric prerelease identifiers before non-numeric identifiers', () => {
    expect(compareSemver('1.0.0-1', '1.0.0-alpha')).toBe(-1)
    expect(compareSemver('1.0.0-alpha.2', '1.0.0-alpha.11')).toBe(-1)
    expect(compareSemver('1.0.0-alpha', '1.0.0-alpha')).toBe(0)
  })

  it('ignores build metadata when comparing precedence', () => {
    expect(compareSemver('1.2.3+build.1', '1.2.3+build.2')).toBe(0)
    expect(compareSemver('1.2.3-alpha+linux', '1.2.3-alpha+windows')).toBe(0)
  })

  it.each([
    ['1.0', '1.0.0'],
    ['v1.0.0', '1.0.0'],
    ['1.01.0', '1.1.0'],
    ['not-a-version', '1.0.0'],
    ['1.0.0', '']
  ])('returns undefined when either input is invalid: %s / %s', (left, right) => {
    expect(compareSemver(left, right)).toBeUndefined()
  })
})
