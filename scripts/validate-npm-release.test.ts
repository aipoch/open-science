import { describe, expect, it } from 'vitest'

import { validateNpmReleaseTag } from './validate-npm-release.mjs'

describe('validateNpmReleaseTag', () => {
  it('accepts the npm release tag matching the package version', () => {
    expect(
      validateNpmReleaseTag('npm-v0.1.0', {
        name: '@aipoch/open-science',
        version: '0.1.0'
      })
    ).toEqual({
      name: '@aipoch/open-science',
      version: '0.1.0',
      tag: 'npm-v0.1.0'
    })
  })

  it.each(['npm-v0.2.0', 'v0.1.0'])('rejects non-matching release tag %s', (tag) => {
    expect(() =>
      validateNpmReleaseTag(tag, {
        name: '@aipoch/open-science',
        version: '0.1.0'
      })
    ).toThrow(`Release tag ${tag} does not match npm-v0.1.0.`)
  })

  it('rejects an unexpected package name', () => {
    expect(() =>
      validateNpmReleaseTag('npm-v0.1.0', {
        name: '@example/open-science',
        version: '0.1.0'
      })
    ).toThrow('Expected package name @aipoch/open-science, received @example/open-science.')
  })

  it.each([undefined, '', '  '])('rejects a missing package version (%s)', (version) => {
    expect(() =>
      validateNpmReleaseTag('npm-v0.1.0', {
        name: '@aipoch/open-science',
        version
      })
    ).toThrow('The npm package version is missing.')
  })
})
