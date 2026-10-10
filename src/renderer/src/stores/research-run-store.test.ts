// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { useNavigationStore } from './navigation-store'
import { restoreResearchRunReceipts, useResearchRunStore } from './research-run-store'
import { researchIdentity } from '@/pages/workspace/research-draft-identity'

const source = {
  sourceProjectId: 'project-1',
  sourceSessionId: 'source-1',
  sourceImportId: 'import-1',
  sourceTitle: 'Study'
}
const key = researchIdentity(source)
const target = {
  projectId: 'project-1',
  sessionId: 'session-1',
  runId: 'run-1',
  executionInvocationId: 'managed-1'
}

describe('research Run receipts', () => {
  beforeEach(() => {
    localStorage.clear()
    useResearchRunStore.setState({ requests: {} })
    useNavigationStore.setState({ explicitNavigationRevision: 4 })
  })
  it('persists only settled identities and restores without automatic activation', () => {
    const store = useResearchRunStore.getState()
    store.begin('request-1', source)
    store.bind('request-1', { sessionId: 'pending-1', messageId: 'message-1' })
    expect(JSON.parse(localStorage.getItem('open-science.research-run-receipts.v1')!)).toEqual([])
    store.settle('request-1', { sessionId: 'session-1' })
    store.attach('request-1', target)
    const restored = restoreResearchRunReceipts(
      localStorage.getItem('open-science.research-run-receipts.v1')
    )
    expect(restored[key]).toEqual({
      requestId: 'request-1',
      source,
      requestedAt: expect.any(Number),
      sessionId: 'session-1',
      promptMessageId: 'message-1',
      target,
      settled: true,
      autoOpenConsumed: true
    })
    expect(restored[key].autoOpenNavigationRevision).toBeUndefined()
  })
  it('does not allow late callbacks or another destination to replace the current request', () => {
    const store = useResearchRunStore.getState()
    store.begin('old', source)
    store.begin('new', source)
    store.bind('old', { sessionId: 'stale', messageId: 'stale' })
    store.bind('new', { sessionId: 'session-1', messageId: 'message-1' })
    store.attach('new', { ...target, sessionId: 'wrong' })
    expect(useResearchRunStore.getState().requests[key].target).toBeUndefined()
    store.attach('new', target)
    store.attach('new', { ...target, runId: 'later-run' })
    expect(useResearchRunStore.getState().requests[key].target).toEqual(target)
  })
  it('keeps repeated imports separate and bounds locally retained receipts', () => {
    const store = useResearchRunStore.getState()
    for (let i = 0; i < 40; i++)
      store.begin(`request-${i}`, { ...source, sourceImportId: `import-${i}` })
    expect(Object.keys(useResearchRunStore.getState().requests)).toHaveLength(30)
  })
  it('rejects malformed, cross-destination or credential-bearing persisted entries', () => {
    const receipt = {
      requestId: 'request-1',
      source,
      requestedAt: 1,
      sessionId: 'session-1',
      promptMessageId: 'message-1',
      target
    }
    expect(restoreResearchRunReceipts('not-json')).toEqual({})
    expect(
      restoreResearchRunReceipts(
        JSON.stringify([{ ...receipt, target: { ...target, sessionId: 'foreign' } }])
      )
    ).toEqual({})
    expect(
      restoreResearchRunReceipts(JSON.stringify([{ ...receipt, url: 'http://secret' }]))
    ).toEqual({})
    expect(
      restoreResearchRunReceipts(
        JSON.stringify([{ ...receipt, target: { ...target, grant: 'credential' } }])
      )
    ).toEqual({})
  })
})
