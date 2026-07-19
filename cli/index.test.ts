import { describe, expect, it } from 'vitest'

import { parseCliArgs } from './index.mjs'

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
})
