// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { setupWebActivityRender } from './workspace-web-render-test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { PackageWebActivityEvidence } from '../../../../shared/session-package-web'
import { fetchActivity } from './workspace-web-fetch-test-fixtures'
import { readPackageWebEvidence } from './workspace-package-web-evidence'
import { WorkspacePackageWebActivityRow } from './WorkspacePackageWebActivityRow'
import { WorkspaceActivityGroup } from './WorkspaceActivityGroup'
import { ReplayToolRecord } from './replay/ReplayToolRecord'
import { PackageWebOmissions } from '@/components/PackageWebOmissions'

vi.mock('@/components/ui/message-scroller', () => ({
  MessageScrollerItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useMessageScroller: () => ({ stopAutoScroll: vi.fn() })
}))
const packet = (): PackageWebActivityEvidence => ({
  schema: 'open-science.package-web.v1',
  activityId: 'tool-1',
  invocationId: 'invocation-1',
  operation: 'fetch',
  status: 'ok',
  provenance: { origin: 'independent-fetch', policyVersion: 'allow-body-only' },
  sources: [],
  document: {
    text: '<img src="https://tracker.test/image"><script>alert(1)</script>\nSaved allowed body.',
    truncated: true
  },
  omissions: [{ component: 'source_manifest', reason: 'policy-denied', count: 1 }]
})

describe('policy-filtered package Web evidence', () => {
  const view = setupWebActivityRender()
  const renderRow = (
    evidence: PackageWebActivityEvidence,
    activity = fetchActivity()
  ): Promise<void> =>
    view.render(
      <WorkspacePackageWebActivityRow
        activity={activity}
        evidence={evidence}
        isExpanded
        onToggle={vi.fn()}
      />
    )

  it('shows body without inventing a URL when source metadata sharing is denied', async () => {
    const evidence = packet()
    const activity = fetchActivity({ packageWebEvidence: evidence })
    expect(readPackageWebEvidence(activity)).toEqual(evidence)
    await renderRow(evidence, activity)
    expect(view.container.textContent).toContain('Saved allowed body.')
    expect(view.container.textContent).toContain('Sharing is not permitted by the data policy')
    expect(view.container.textContent).toContain('Read-only')
    expect(view.container.textContent).toContain('Page excerpt')
    expect(view.container.textContent).toContain('Partial page text')
    expect(view.container.querySelector('a, img, script, iframe')).toBeNull()
    expect(view.container.textContent).not.toContain('Retry')
    expect(view.container.textContent).not.toContain('example.org')
    expect(view.container.querySelectorAll('button')).toHaveLength(1)
  })

  it('renders allowed source metadata without a body or executable recovery', async () => {
    const evidence = packet()
    delete evidence.document
    evidence.sources = [
      { sourceId: 'local-source', title: 'Allowed source', url: 'https://example.org/methods' }
    ]
    evidence.omissions = [{ component: 'fetch_body', reason: 'policy-unknown', count: 1 }]
    await renderRow(evidence)
    expect(view.container.querySelector('a')?.href).toBe('https://example.org/methods')
    expect(view.container.textContent).toContain('Sharing permission has not been confirmed')
    expect(view.container.querySelector('[data-testid="package-web-source"]')?.textContent).toBe(
      'Allowed sourcehttps://example.org/methods'
    )
    expect(view.container.querySelector('pre')).toBeNull()
    expect(view.container.textContent).not.toContain('Retry')
  })

  it.each(['error', 'unavailable'] as const)(
    'shows recorded %s without executable recovery',
    async (status) => {
      const evidence = packet()
      evidence.status = status
      delete evidence.document
      if (status === 'error') evidence.errorCode = 'HTTP_ERROR'
      await renderRow(evidence)
      expect(view.container.textContent).toContain(
        status === 'error' ? 'The web page could not be read' : 'Result unavailable'
      )
      expect(view.container.textContent).not.toContain('Retry')
      expect(view.container.textContent).not.toContain('Saved allowed body.')
      if (status === 'error') {
        const details = view.container.querySelector('details')
        expect(details?.open).toBe(false)
        expect(details?.textContent).toContain('HTTP_ERROR')
      } else {
        expect(view.container.querySelector('details')).toBeNull()
      }
    }
  )

  it.each([
    { toolDisposition: 'cancelled', copy: 'Cancelled', status: 'error' },
    { toolDisposition: 'declined', copy: 'Declined', status: 'unavailable' }
  ] as const)(
    'shows recorded $toolDisposition without publishing late evidence',
    async ({ toolDisposition, copy, status }) => {
      await renderRow({ ...packet(), status }, fetchActivity({ toolDisposition }))
      expect(view.container.querySelector('[role=status]')?.textContent).toBe(copy)
      expect(view.container.textContent).not.toContain('The web page could not be read')
      expect(view.container.textContent).not.toContain('Saved allowed body.')
    }
  )

  it('requires host-owned canonical identity and matching activity/invocation before classification', () => {
    const activity = fetchActivity({ packageWebEvidence: packet() })
    for (const changed of [
      { appOwned: undefined },
      { id: 'another' },
      { executionInvocationId: 'another' },
      { providerToolName: 'mcp__external__web_fetch' }
    ])
      expect(readPackageWebEvidence({ ...activity, ...changed })).toBeUndefined()
    expect(
      readPackageWebEvidence({
        ...activity,
        packageWebEvidence: {
          ...packet(),
          sources: [{ sourceId: 'unsafe', url: 'javascript:alert(1)' }]
        }
      })
    ).toBeUndefined()
    expect(
      readPackageWebEvidence({
        ...activity,
        packageWebEvidence: {
          ...packet(),
          schema: 'open-science.package-web.v2'
        } as unknown as PackageWebActivityEvidence
      })
    ).toBeUndefined()
  })

  it('uses the same partial evidence row in the workspace and read-only replay', async () => {
    const activity = fetchActivity({ packageWebEvidence: packet() })
    await view.render(
      <WorkspaceActivityGroup
        group={{
          id: 'package-group',
          type: 'activity-group',
          createdAt: 1,
          sortIndex: 1,
          activities: [activity]
        }}
        isExpanded
        onToggleGroup={vi.fn()}
        onToggleRow={vi.fn()}
        expansionOverrides={{ [activity.id]: true }}
      />
    )
    expect(
      view.container.querySelector('[data-testid="package-web-evidence"]')?.textContent
    ).toContain('Saved allowed body.')
    expect(view.container.textContent).not.toContain('Saved page text')
    await view.render(<ReplayToolRecord activity={activity} showResults interactive />)
    await act(async () =>
      view.container.querySelector<HTMLButtonElement>('[data-testid="tool-chip"]')!.click()
    )
    expect(
      view.container.querySelector('[data-testid="package-web-evidence"]')?.textContent
    ).toContain('Saved allowed body.')
    expect(view.container.textContent).not.toContain('Retry')
    await view.render(<ReplayToolRecord activity={activity} showResults />)
    expect(
      view.container.querySelector('[data-testid="package-web-evidence"]')?.textContent
    ).toContain('Saved allowed body.')
    await view.render(<ReplayToolRecord activity={activity} showResults={false} interactive />)
    expect(view.container.querySelector('[data-testid="package-web-evidence"]')).toBeNull()
    expect(view.container.textContent).not.toContain('Saved allowed body.')
  })

  it('shows typed omission scope and reasons, omitting invalid entries', async () => {
    await view.render(
      <PackageWebOmissions
        omissions={[
          { component: 'query_history', reason: 'policy-unknown', count: 2 },
          { component: 'provider_excerpt', reason: 'missing', count: 3 },
          { component: 'fetch_body', reason: 'invalid', count: 1 }
        ]}
      />
    )
    expect(view.container.textContent).toContain('Web query history: 2')
    expect(view.container.textContent).toContain('Search service excerpts: 3')
    expect(view.container.textContent).toContain('Recorded evidence failed validation')
    expect(view.container.querySelectorAll('li')).toHaveLength(3)
    await view.render(<PackageWebOmissions omissions={[]} />)
    expect(view.container.innerHTML).toBe('')
  })
})
