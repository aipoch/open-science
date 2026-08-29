// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { JobSummary } from '../../../shared/compute'
import { CompletedJobCard } from './CompletedJobCard'
import { RemoteJobRow } from './RemoteJobRow'
import { UpdateCapsule } from './UpdateCapsule'
import { GitHubStarBadge } from './GitHubStarBadge'
import { LinkSafetyModal } from './streamdown/LinkSafetyModal'
import { useUpdateStore } from '@/stores/update-store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// window.api stubs so component effects that call IPC don't throw.
Object.defineProperty(globalThis.window, 'api', {
  configurable: true,
  writable: true,
  value: { github: { getStars: () => Promise.resolve(null) } }
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

// Shared defaults for the required JobSummary fields the cards don't read, so each fixture below
// only spells out what its assertions depend on.
const jobDefaults = {
  provider_id: 'p1',
  shape: 'cpu-small',
  session_id: 's1',
  started_at: undefined,
  finished_at: undefined,
  exit_code: undefined,
  error_code: undefined,
  remote_workdir: undefined,
  stdout_tail: undefined,
  stderr_tail: undefined,
  notified_at: undefined,
  notification_consumed_at: undefined
} satisfies Partial<JobSummary>

const successJob: JobSummary = {
  ...jobDefaults,
  job_id: 'j1',
  intent: 'Run tests',
  status: 'success',
  display_name: 'host-1',
  created_at: Date.now() - 5000,
  started_at: Date.now() - 4000,
  finished_at: Date.now()
}

const submittedJob: JobSummary = {
  ...jobDefaults,
  job_id: 'j2',
  intent: 'Build project',
  status: 'submitted',
  display_name: 'host-2',
  created_at: Date.now() - 1000
}

describe('components batch i18n — en strings', () => {
  it('CompletedJobCard renders translated "finished" status', () => {
    act(() => {
      root.render(<CompletedJobCard job={successJob} onOpen={vi.fn()} />)
    })
    expect(container.textContent).toContain('finished')
  })

  it('CompletedJobCard aria-label uses catalog key', () => {
    act(() => {
      root.render(<CompletedJobCard job={successJob} onOpen={vi.fn()} />)
    })
    const btn = container.querySelector('[data-testid="completed-job-card"]')
    expect(btn?.getAttribute('aria-label')).toContain('Run tests')
  })

  it('RemoteJobRow renders the submitting label', () => {
    act(() => {
      root.render(<RemoteJobRow job={submittedJob} onOpen={vi.fn()} />)
    })
    expect(container.textContent).toContain('Submitting')
  })

  it('RemoteJobRow aria-label uses catalog key', () => {
    act(() => {
      root.render(<RemoteJobRow job={submittedJob} onOpen={vi.fn()} />)
    })
    const btn = container.querySelector('[data-testid="remote-job-row"]')
    expect(btn?.getAttribute('aria-label')).toContain('Build project')
  })

  it('UpdateCapsule renders translated "Update" label when update is available', () => {
    useUpdateStore.setState({
      status: { state: 'available', current: '0.7.2', latest: '0.8.0', notes: '' }
    })
    act(() => {
      root.render(<UpdateCapsule />)
    })
    expect(container.textContent).toContain('Update')
    const btn = container.querySelector('button')
    expect(btn?.getAttribute('aria-label')).toContain('0.8.0')
  })

  it('GitHubStarBadge aria-label uses catalog key', () => {
    act(() => {
      root.render(<GitHubStarBadge />)
    })
    const link = container.querySelector('a')
    expect(link?.getAttribute('aria-label')).toContain('GitHub')
  })

  it('LinkSafetyModal renders translated description and action labels', () => {
    act(() => {
      root.render(
        <LinkSafetyModal
          url="https://example.com"
          isOpen={true}
          onClose={vi.fn()}
          onConfirm={vi.fn()}
        />
      )
    })
    // Modal is rendered into document.body via portal — query there.
    expect(document.body.textContent).toContain('external website')
    expect(document.body.textContent).toContain('Copy link')
    expect(document.body.textContent).toContain('Open link')
  })
})
