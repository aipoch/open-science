import type { ToolActivity } from '@/stores/session-store-contract'
import type { WebResult } from '../../../../shared/web-tools'

export const fetchResult = (): WebResult => ({
  schema: 'open-science.web.v1',
  invocation_id: 'invocation-1',
  operation: 'fetch',
  status: 'ok',
  request: { url: 'https://example.org/start' },
  retrieved_at: '2026-11-16T12:00:00.000Z',
  duration_ms: 123,
  sources: [
    {
      source_id: 'page-1',
      url: 'https://example.org/final',
      evidence_kind: 'page_extract',
      snapshot_id: 'snapshot-1'
    }
  ],
  document: {
    snapshot_id: 'snapshot-1',
    final_url: 'https://example.org/final',
    fetched_at: '2026-11-16T11:59:00.000Z',
    content_type: 'text/html',
    extraction_method: 'main_content',
    extraction_quality: 'normal',
    extractor_version: 'v1',
    sha256: 'a'.repeat(64),
    text: 'Saved page text',
    start_line: 1,
    end_line: 1,
    total_lines: 1,
    truncated: false
  },
  cache: { hit: false }
})

export const fetchActivity = (overrides: Partial<ToolActivity> = {}): ToolActivity => ({
  id: 'tool-1',
  kind: 'tool',
  title: 'web_fetch',
  providerToolName: 'mcp__open_science_web__web_fetch',
  appOwned: true,
  executionInvocationId: 'invocation-1',
  toolKind: 'fetch',
  status: 'completed',
  sortIndex: 1,
  eventIds: [],
  createdAt: 1,
  updatedAt: 2,
  rawInput: { url: 'https://example.org/start' },
  toolContent: [
    { type: 'content', content: { type: 'text', text: JSON.stringify(fetchResult()) } }
  ],
  ...overrides
})
