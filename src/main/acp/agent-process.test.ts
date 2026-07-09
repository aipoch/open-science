import { describe, expect, it } from 'vitest'

import { toUnpackedAsarPath } from './agent-process'

describe('ACP agent process packaging paths', () => {
  it('uses the real unpacked path for executables resolved inside app.asar', () => {
    expect(
      toUnpackedAsarPath(
        '/Applications/Open Science.app/Contents/Resources/app.asar/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'
      )
    ).toBe(
      '/Applications/Open Science.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'
    )
  })

  it('leaves development node_modules paths unchanged', () => {
    expect(
      toUnpackedAsarPath(
        '/Users/lj/Desktop/cs/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'
      )
    ).toBe('/Users/lj/Desktop/cs/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude')
  })
})
