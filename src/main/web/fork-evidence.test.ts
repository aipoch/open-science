import { describe, expect, it } from 'vitest'
import type { PersistedChatSession, PersistedToolActivity } from '../../shared/session-persistence'
import type { WebResult } from '../../shared/web-tools'
import { mapPackageReferences } from '../session-package/native-snapshot'
import { inheritedWebSnapshotIds } from './evidence-lifecycle'
import { preserveLocalForkWebEvidence } from './fork-evidence'

const invocation = 'host-invocation/tool-call',
  snapshot = '11111111-1111-4111-8111-111111111111'
const result: WebResult = {
  schema: 'open-science.web.v1',
  invocation_id: invocation,
  operation: 'fetch',
  status: 'ok',
  request: { url: 'https://example.org/' },
  retrieved_at: '2026-11-16T08:00:00.000Z',
  duration_ms: 10,
  sources: [
    {
      source_id: snapshot,
      url: 'https://example.org/',
      snapshot_id: snapshot,
      evidence_kind: 'page_extract'
    }
  ],
  document: {
    snapshot_id: snapshot,
    final_url: 'https://example.org/',
    fetched_at: '2026-11-16T08:00:00.000Z',
    content_type: 'text/plain',
    extraction_method: 'plain_text',
    extraction_quality: 'normal',
    extractor_version: 'v1',
    sha256: 'a'.repeat(64),
    text: 'prefix',
    start_line: 1,
    end_line: 1,
    total_lines: 1,
    truncated: true,
    next_cursor: 'immutable.cursor'
  }
}
const parent = (surface: 'rawOutput' | 'toolContent'): PersistedChatSession => ({
  id: 'parent',
  projectId: 'project',
  title: 'Parent',
  cwd: '',
  status: 'idle',
  createdAt: 1,
  updatedAt: 50,
  messages: [
    {
      id: 'user',
      role: 'user',
      content: 'Read',
      status: 'complete',
      eventIds: [],
      createdAt: 10,
      updatedAt: 10
    },
    {
      id: 'answer',
      role: 'agent',
      content: 'Answer',
      status: 'complete',
      eventIds: [],
      createdAt: 50,
      updatedAt: 50,
      completedAt: 50
    }
  ],
  activities: [
    {
      id: invocation,
      kind: 'tool',
      title: 'arbitrary display title',
      executionInvocationId: invocation,
      providerToolName: 'mcp__open_science_web__web_fetch',
      appOwned: true,
      status: 'completed',
      sortIndex: 1,
      eventIds: [],
      promptMessageId: 'user',
      createdAt: 20,
      updatedAt: 30,
      webInvocation: {
        attempt: 1,
        configGeneration: 'generation',
        branchId: 'parent-branch',
        retryEligible: true
      },
      rawInput: { url: 'https://example.org/' },
      ...(surface === 'rawOutput'
        ? { rawOutput: result }
        : {
            toolContent: [
              { type: 'content', content: { type: 'text', text: JSON.stringify(result) } }
            ]
          })
    }
  ]
})

describe('local Fork immutable Web provenance', () => {
  it.each(['rawOutput', 'toolContent'] as const)(
    'preserves canonical host identity and complete %s despite generic native remapping',
    (surface) => {
      const source = parent(surface),
        original = structuredClone(source)
      const identities = {
        [invocation]: 'child-activity-id',
        parent: 'child',
        answer: 'child-answer',
        user: 'child-user'
      }
      const mapped = mapPackageReferences(source, identities) as PersistedChatSession
      const child = { ...mapped, branchSource: { sessionId: source.id, headMessageId: 'answer' } }
      expect(child.activities![0].executionInvocationId).toBe('child-activity-id')
      expect(inheritedWebSnapshotIds(source, child)).toEqual([])
      const preserved = preserveLocalForkWebEvidence(source, child, identities)
      expect(preserved.activities![0].id).toBe('child-activity-id')
      expect(preserved.activities![0].executionInvocationId).toBe(invocation)
      expect(preserved.activities![0][surface]).toEqual(source.activities![0][surface])
      expect(preserved.activities![0].rawInput).toEqual(source.activities![0].rawInput)
      expect(preserved.activities![0].webInvocation?.retryEligible).toBeUndefined()
      expect(inheritedWebSnapshotIds(source, preserved)).toEqual([snapshot])
      expect(source).toEqual(original)
    }
  )

  it('requires the canonical host identity and exact native identity map, never matching by title', () => {
    const source = parent('rawOutput')
    source.activities!.push({
      ...source.activities![0],
      id: 'external',
      appOwned: undefined,
      executionInvocationId: 'external',
      providerToolName: 'mcp__external__web_fetch'
    } as PersistedToolActivity)
    const identities = { [invocation]: 'child-host', external: 'child-external' }
    const child = mapPackageReferences(source, identities) as PersistedChatSession
    const copied = preserveLocalForkWebEvidence(source, child, identities)
    expect(copied.activities![0].executionInvocationId).toBe(invocation)
    expect(copied.activities![1].executionInvocationId).toBe('child-external')
  })
})
