import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

import {
  assertDifferentialObservation,
  buildLocalUpdaterConfig,
  parseArguments,
  parseSingleRange,
  rewriteFeedPaths
} from './windows-updater-certification.mjs'

describe('Windows updater certification', () => {
  it('points the installed updater at a local feed without weakening its signing policy', () => {
    const result = buildLocalUpdaterConfig(
      'provider: generic\nurl: https://example.test\nupdaterCacheDirName: app-updater\npublisherName: Old Signer\n',
      'http://127.0.0.1:4321'
    )

    expect(result.updaterCacheDirName).toBe('app-updater')
    expect(load(result.source)).toMatchObject({
      provider: 'generic',
      url: 'http://127.0.0.1:4321',
      channel: 'latest',
      useMultipleRangeRequest: false
    })
    expect(load(result.source)).toHaveProperty('publisherName', 'Old Signer')
  })

  it('accepts one bounded HTTP range and rejects multipart ranges', () => {
    expect(parseSingleRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
    expect(parseSingleRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(parseSingleRange('bytes=100-', 100)).toBeUndefined()
    expect(() => parseSingleRange('bytes=0-1,4-5', 100)).toThrow(/Unsupported HTTP range/)
  })

  it('models the production versioned feed used for skipped-version blockmap lookup', () => {
    expect(
      rewriteFeedPaths(
        'path: open-science-0.11.0-win-x64-setup.exe\nfiles:\n  - url: open-science-0.11.0-win-x64-setup.exe\n',
        '0.11.0'
      )
    ).toBe(
      'path: releases/0.11.0/open-science-0.11.0-win-x64-setup.exe\nfiles:\n  - url: releases/0.11.0/open-science-0.11.0-win-x64-setup.exe\n'
    )
  })

  it('fails when electron-updater falls back to a complete installer download', () => {
    const observation = {
      feedRequests: 1,
      blockmapRequests: 2,
      rangeRequests: 2,
      fullInstallerRequests: 0,
      downloadedInstallerBytes: 40,
      installerBytes: 100,
      versionedFeed: true,
      previousInstallerCacheVerified: true,
      previousVersion: '0.10.0',
      currentVersion: '0.11.0'
    }
    expect(assertDifferentialObservation(observation)).toBe(observation)
    expect(() =>
      assertDifferentialObservation({ ...observation, fullInstallerRequests: 1 })
    ).toThrow(/complete differential path/)
    expect(() =>
      assertDifferentialObservation({ ...observation, downloadedInstallerBytes: 100 })
    ).toThrow(/complete differential path/)
  })

  it('requires both release artifact directories and an evidence output', () => {
    expect(
      parseArguments([
        '--current-dir',
        'current',
        '--previous-dir',
        'previous',
        '--output',
        'observation.json'
      ])
    ).toMatchObject({
      currentDirectory: expect.stringContaining('current'),
      previousDirectory: expect.stringContaining('previous'),
      output: expect.stringContaining('observation.json')
    })
    expect(() => parseArguments(['--current-dir', 'current'])).toThrow(/Usage/)
  })
})
