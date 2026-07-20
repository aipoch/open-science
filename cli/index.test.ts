import { describe, expect, it } from 'vitest'

import { isProcessAlive, parseCliArgs } from './index.mjs'

describe('CLI argument parsing', () => {
  it('parses start options', () => {
    expect(
      parseCliArgs([
        'start',
        '--port',
        '44200',
        '--app-path',
        '/opt/open-science',
        '--config-root',
        '/tmp/open-science',
        '--no-open'
      ])
    ).toEqual({
      command: 'start',
      options: {
        open: false,
        json: false,
        port: 44200,
        appPath: '/opt/open-science',
        configRoot: '/tmp/open-science'
      }
    })
  })

  it('parses status JSON output and rejects invalid options', () => {
    expect(parseCliArgs(['status', '--json'])).toEqual({
      command: 'status',
      options: { open: true, json: true }
    })
    expect(() => parseCliArgs(['start', '--port', '70000'])).toThrow('Invalid port')
    expect(() => parseCliArgs(['start', '--unknown'])).toThrow('Unknown option')
  })

  it('requires a value for value-taking flags', () => {
    expect(() => parseCliArgs(['start', '--app-path'])).toThrow('requires a value')
    expect(() => parseCliArgs(['start', '--config-root'])).toThrow('requires a value')
  })
})

describe('isProcessAlive', () => {
  it('returns true for the running test process', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('returns false for invalid or non-existent pids', () => {
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
    expect(isProcessAlive(Number.NaN)).toBe(false)
    // A pid this large is effectively certain not to be running.
    expect(isProcessAlive(2 ** 30)).toBe(false)
  })
})
