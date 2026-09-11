import { describe, expect, it } from 'vitest'
import { decodeReviewLog, decodeReviewScope } from './review-json'

const scope = { turnMessageId: 'turn', blocks: [], artifactVersionIds: [] }
describe('Review JSON decoding', () => {
  it.each([
    null,
    {},
    [],
    { ...scope, artifactVersionIds: {} },
    { ...scope, artifactVersionIds: [42] },
    { ...scope, sourceDocumentVersionIds: [null] },
    { ...scope, blocks: [{}] },
    {
      ...scope,
      blocks: [{ id: 'b', kind: 'message', sourceId: 'turn', contentHash: 'hash', blockIndex: -1 }]
    }
  ])('rejects invalid scope structure %j', (value) => {
    expect(decodeReviewScope(JSON.stringify(value))).toBeUndefined()
  })
  it('keeps legacy scopes and typed log entries readable', () => {
    expect(decodeReviewScope(JSON.stringify(scope))).toEqual(scope)
    const log = [
      { kind: 'message', text: 'result' },
      { kind: 'tool', toolName: 'read', exitCode: null }
    ]
    expect(decodeReviewLog(JSON.stringify(log))).toEqual(log)
    expect(decodeReviewLog('[{"kind":"tool"}]')).toBeUndefined()
    expect(decodeReviewLog('{}')).toBeUndefined()
  })
})
