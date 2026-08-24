// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import '@/i18n'
import type { ToolActivity } from '@/stores/session-store'
import { WorkspaceContextCompactionActivityRow } from './WorkspaceContextCompactionActivityRow'

vi.mock('@/components/ui/message-scroller', () => ({
  MessageScrollerItem: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

const activity = (overrides: Partial<ToolActivity> = {}): ToolActivity => ({
  id: 'context-compaction:1',
  kind: 'tool',
  title: 'Context compacted',
  status: 'completed',
  eventIds: [],
  sortIndex: 1,
  providerToolName: 'ContextCompaction',
  toolKind: 'other',
  createdAt: 1,
  updatedAt: 2,
  ...overrides
})

const renderActivity = (overrides?: Partial<ToolActivity>): string =>
  renderToStaticMarkup(<WorkspaceContextCompactionActivityRow activity={activity(overrides)} />)

describe('WorkspaceContextCompactionActivityRow', () => {
  it('renders completed compaction as a non-interactive conversation boundary', () => {
    const html = renderActivity()

    expect(html).toContain('Context compacted')
    expect(html).toContain('Earlier context was summarized so the session can continue.')
    expect(html).toContain('lucide-minimize-2')
    expect(html).not.toContain('role="status"')
    expect(html).not.toContain('tool-chip')
  })

  it('renders the active lifecycle with live summary copy', () => {
    const html = renderActivity({ status: 'in_progress', title: 'Compacting context' })

    expect(html).toContain('Compacting context')
    expect(html).toContain('Summarizing earlier context…')
    expect(html).toContain('lucide-loader-circle')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
  })

  it('explains that failed or cancelled compaction leaves earlier context unchanged', () => {
    const failed = renderActivity({ status: 'failed', title: 'Context compaction failed' })
    const cancelled = renderActivity({ title: 'Context compaction cancelled' })

    expect(failed).toContain('Context compaction failed')
    expect(failed).toContain('Earlier context is unchanged.')
    expect(failed).toContain('lucide-circle-alert')
    expect(cancelled).toContain('Context compaction cancelled')
    expect(cancelled).toContain('Earlier context is unchanged.')
    expect(cancelled).toContain('lucide-circle-minus')
  })
})
