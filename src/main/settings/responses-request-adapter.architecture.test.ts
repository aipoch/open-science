import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readProductionSource } from '../../../test/architecture-source-index'

const projectRoot = resolve(__dirname, '../../..')
const bridgePath = resolve(__dirname, 'responses-to-chat-completions-bridge.ts')
const hostPath = resolve(__dirname, 'provider-loopback-http-host.ts')

describe('Responses request host contract', () => {
  it('delegates conversion through the public package and retains HTTP/session ownership', () => {
    const bridge = readProductionSource(bridgePath, projectRoot)
    const host = readProductionSource(hostPath, projectRoot)
    expect(bridge).toContain("from '@aipoch/providers/protocol'")
    expect(bridge).not.toMatch(
      /export .*?(?:responsesToChatCompletionsRequest|completionToResponse|upstreamErrorMessage|toolsToChat)/
    )
    expect(bridge).not.toContain('createServer(')
    expect(bridge).toContain('new ProviderLoopbackHttpHost')
    expect(host).toContain('createServer(')
    expect(bridge).toContain('reviewerSessionKeys')
    expect(bridge).not.toContain('reasoningByPromptCacheKey')
    expect(bridge).toContain('this.adapter.prepare(')
    expect(bridge).toContain('turn.convert(upstream)')
  })
})
