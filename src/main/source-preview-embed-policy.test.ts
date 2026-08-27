import { describe, expect, it } from 'vitest'

import { createSourcePreviewEmbedPolicy } from './source-preview-embed-policy'

describe('source preview embed policy', () => {
  it('stops rewriting headers after a source is released', () => {
    const policy = createSourcePreviewEmbedPolicy(101) as ReturnType<
      typeof createSourcePreviewEmbedPolicy
    > & {
      registerRoot: (frame: { frameTreeNodeId: number }, sourceUrl: string) => void
      releaseSource?: (sourceUrl: string) => void
    }
    const frame = { frameTreeNodeId: 7 }
    const details = {
      webContentsId: 101,
      frame,
      resourceType: 'subFrame',
      url: 'https://example.com/paper',
      statusCode: 200,
      responseHeaders: { 'x-frame-options': ['DENY'] }
    }

    policy.registerRoot(frame, 'https://example.com/paper')
    expect(policy.rewriteResponseHeaders(details)).toEqual({})
    expect(policy.releaseSource).toBeTypeOf('function')
    policy.releaseSource?.('https://example.com/paper')

    expect(policy.rewriteResponseHeaders(details)).toBeUndefined()
  })
})
