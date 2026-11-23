// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotebookProcessMonitorSnapshot } from '../../../../shared/notebook-process-monitor'
import { ComputeProcessMonitor } from './ComputeProcessMonitor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const snapshot = (): NotebookProcessMonitorSnapshot => ({
  sampledAt: Date.now(),
  processMetricsAvailable: true,
  host: {
    hostname: 'test-host',
    platform: 'darwin',
    cpuCount: 8,
    cpuPercent: 25,
    memoryTotalBytes: 16 * 1024 ** 3,
    memoryUsedBytes: 8 * 1024 ** 3,
    memoryCommittedBytes: 8 * 1024 ** 3,
    memoryCommitLimitBytes: 16 * 1024 ** 3,
    uptimeSeconds: 100
  },
  instances: ['python', 'repl', 'shell'].map((kind, index) => ({
    id: `instance-${index}`,
    projectId: index === 2 ? 'p2' : 'p1',
    sessionId: 'same-session',
    kind: kind as 'python' | 'repl' | 'shell',
    lane: 'root',
    status: 'idle',
    startedAt: Date.now() - 60_000,
    pid: 100 + index,
    processes: [{ pid: 100 + index, parentPid: 1, command: kind }]
  }))
})

describe('Compute process monitoring', () => {
  let root: Root
  let container: HTMLDivElement
  const read = vi.fn()
  const terminate = vi.fn()
  beforeEach(() => {
    vi.useFakeTimers()
    read.mockReset().mockResolvedValue(snapshot())
    terminate.mockReset().mockResolvedValue(undefined)
    Object.assign(window, {
      api: { notebook: { getProcessMonitor: read, terminateMonitoredProcess: terminate } }
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    document.body.innerHTML = ''
    vi.useRealTimers()
  })
  const mount = async (isActive = true): Promise<void> => {
    await act(async () =>
      root.render(
        <ComputeProcessMonitor
          isActive={isActive}
          projectId="p1"
          sessionTitles={new Map([['same-session', 'Analysis']])}
          openSession={() => {}}
        />
      )
    )
  }
  const click = async (label: string, scope: ParentNode = container): Promise<void> => {
    const button = [...scope.querySelectorAll('button')].find(
      (item) => item.textContent === label || item.getAttribute('aria-label') === label
    )
    expect(button, label).toBeDefined()
    await act(async () => button!.click())
  }

  const toggleSession = async (index = 0): Promise<void> => {
    const button = container.querySelectorAll<HTMLButtonElement>('button[aria-controls]')[index]
    expect(button).toBeDefined()
    await act(async () => button.click())
  }
  const totals = (): string =>
    container.querySelector('[data-testid="kernel-summary"]')!.textContent!

  it('starts with collapsed sessions and reveals every interpreter across projects on demand', async () => {
    await mount()
    expect(container.textContent).toContain('test-host')
    expect(container.textContent).toContain('25.0%')
    expect(totals()).toContain('3 kernels')
    expect(
      container.querySelectorAll('details[data-kernel-details], pre, table, svg[role="img"]')
    ).toHaveLength(0)
    await toggleSession()
    expect(container.querySelector('[role="img"][aria-label="Python"]')).not.toBeNull()
    expect(container.querySelector('[role="img"][aria-label="JavaScript REPL"]')).not.toBeNull()
    await toggleSession(1)
    expect(container.querySelector('[role="img"][aria-label="Shell"]')).not.toBeNull()
    await click('Current project')
    expect(totals()).toContain('2 kernels')
    expect(container.querySelector('[role="img"][aria-label="Shell"]')).toBeNull()
    await click('All kernels')
    expect(totals()).toContain('3 kernels')
    expect(container.querySelector('[role="img"][aria-label="Shell"]')).not.toBeNull()
  })

  it('shows commit usage and its limit in system details', async () => {
    await mount()
    expect(container.textContent).toContain('Committed / limit')
    expect(container.textContent).toContain('8.0 GB / 16.0 GB')
  })

  it('sums current kernel uptimes per session, including idle time, without a duration column', async () => {
    const sample = snapshot()
    sample.instances[0].startedAt = sample.sampledAt - 90_000
    sample.instances[1].startedAt = sample.sampledAt - 120_000
    sample.instances[2].startedAt = sample.sampledAt + 5_000
    read.mockResolvedValue(sample)
    await mount()
    expect(
      [...container.querySelectorAll('[data-session-uptime]')].map((item) => item.textContent)
    ).toEqual(['3m', '0s'])
    expect(
      container.querySelector('[aria-label="Total kernel uptime: 3m"]')?.getAttribute('title')
    ).toContain('including idle time')
    expect(
      container.querySelectorAll('svg[aria-label="CPU usage"], svg[aria-label="Memory usage"]')
    ).toHaveLength(0)
    await toggleSession()
    expect(
      container.querySelectorAll('svg[aria-label="CPU usage"], svg[aria-label="Memory usage"]')
    ).toHaveLength(0)
  })

  it('keeps low CPU visible and scopes totals to the selected project', async () => {
    const sample = snapshot()
    sample.instances.forEach((item, index) => {
      item.cpuCores = index === 0 ? 0.0032 : 0.1
      item.memoryBytes = 10 * 1024 ** 2
    })
    read.mockResolvedValue(sample)
    await mount()
    await toggleSession()
    expect(container.querySelector('[title="0.32% CPU · 100% = 1 core"]')?.textContent).toContain(
      '0.003'
    )
    expect(totals()).toContain('30.0 MB')
    expect(totals()).toContain('0.20 cores')
    await click('Current project')
    expect(totals()).toContain('20.0 MB')
    expect(totals()).toContain('0.10 cores')
  })

  it('keeps a partial tiny CPU total as a valid nonzero lower bound', async () => {
    const sample = snapshot()
    sample.instances[0].cpuCores = 0.0001
    read.mockResolvedValue(sample)
    await mount()
    expect(totals()).toContain('> 0 cores')
    expect(totals()).not.toContain('≥ <')
  })

  it('offers all kernels when the selected project is empty', async () => {
    const sample = snapshot()
    sample.instances = sample.instances.filter((item) => item.projectId !== 'p1')
    read.mockResolvedValue(sample)
    await mount()
    await click('Current project')
    expect(totals()).toContain('0 kernels')
    expect(container.textContent).toContain('No kernels in this project')
    await click('View all kernels (1)')
    expect(totals()).toContain('1 kernel')
    expect(container.textContent).not.toContain('No kernels in this project')
  })

  it('preserves expanded sessions through polling and starts new sessions collapsed', async () => {
    const sample = snapshot()
    read.mockResolvedValue(sample)
    await mount()
    await toggleSession()
    read.mockResolvedValue({
      ...sample,
      sampledAt: sample.sampledAt + 3000,
      instances: [
        ...sample.instances,
        { ...sample.instances[0], id: 'new', sessionId: 'new-session' }
      ]
    })
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    const toggles = container.querySelectorAll('button[aria-controls]')
    expect([...toggles].map((button) => button.getAttribute('aria-expanded'))).toEqual([
      'true',
      'false',
      'false'
    ])
    expect(container.querySelectorAll('details[data-kernel-details]')).toHaveLength(2)
    await toggleSession()
    expect(
      container.querySelectorAll('details[data-kernel-details], pre, table, svg[role="img"]')
    ).toHaveLength(0)
  })

  it.each([
    [undefined, '—'],
    [0, '0.00'],
    [0.0001, '<0.001'],
    [0.0032, '0.003'],
    [0.15, '0.15']
  ])('renders CPU sample %s as %s cores', async (value, expected) => {
    const sample = snapshot()
    sample.instances = [{ ...sample.instances[0], cpuCores: value }]
    read.mockResolvedValue(sample)
    await mount()
    expect(container.textContent).toContain(`${expected} cores`)
  })

  it('opens an inline form and sends only the exact instance identity for termination', async () => {
    await mount()
    await toggleSession()
    await click('Terminate')
    expect(terminate).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(container.querySelector('textarea')).toBe(document.activeElement)
    await click('Cancel', container.querySelector('form')!)
    expect(terminate).not.toHaveBeenCalled()
    await click('Terminate')
    await click('Terminate', container.querySelector('form')!)
    expect(terminate).toHaveBeenCalledExactlyOnceWith({
      id: 'instance-0',
      projectId: 'p1',
      sessionId: 'same-session'
    })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('groups by session and submits the selected kernels with the comment', async () => {
    await mount()
    expect(container.querySelectorAll('section section')).toHaveLength(2)
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Session actions"]')!.click()
    )
    expect(document.querySelector('[data-action-id="open"]')?.textContent).toBe('Open session')
    await act(async () => document.querySelector<HTMLElement>('[data-action-id="stop"]')!.click())
    const dialog = container.querySelector('form')!
    const textarea = dialog.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        'Use smaller batches'
      )
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('Terminate', dialog)
    expect(terminate).toHaveBeenCalledExactlyOnceWith({
      ids: ['instance-0', 'instance-1'],
      projectId: 'p1',
      sessionId: 'same-session',
      comment: 'Use smaller batches'
    })
  })

  it('pauses a mounted inactive preview and refreshes when it becomes active', async () => {
    await mount()
    await mount(false)
    await act(async () => vi.advanceTimersByTimeAsync(9000))
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(read).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('test-host')
    await mount(true)
    expect(read).toHaveBeenCalledTimes(2)
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('does not publish an in-flight sample after its retained preview becomes inactive', async () => {
    await mount()
    const pending = Promise.withResolvers<NotebookProcessMonitorSnapshot>()
    read.mockReturnValueOnce(pending.promise)
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(read).toHaveBeenCalledTimes(2)
    await mount(false)
    const hiddenSample = snapshot()
    hiddenSample.host.hostname = 'hidden-host'
    await act(async () => pending.resolve(hiddenSample))
    expect(container.textContent).toContain('test-host')
    expect(container.textContent).not.toContain('hidden-host')
    await act(async () => vi.advanceTimersByTimeAsync(9000))
    expect(read).toHaveBeenCalledTimes(2)
    await mount(true)
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('pauses polling in hidden tabs and resumes on visibility', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    try {
      await mount()
      hidden.mockReturnValue(true)
      await act(async () => document.dispatchEvent(new Event('visibilitychange')))
      await act(async () => vi.advanceTimersByTimeAsync(9000))
      expect(read).toHaveBeenCalledTimes(1)
      hidden.mockReturnValue(false)
      await act(async () => document.dispatchEvent(new Event('visibilitychange')))
      expect(read).toHaveBeenCalledTimes(2)
    } finally {
      hidden.mockRestore()
    }
  })

  it('requests source only for expanded rows and accepts source from a cached metric sample', async () => {
    const sample = snapshot()
    read.mockImplementation(async ({ sourceIds }: { sourceIds: string[] }) => ({
      ...sample,
      instances: sample.instances.map((item) => ({
        ...item,
        hasLastCell: true,
        ...(sourceIds.includes(item.id)
          ? { lastCell: { code: 'values = [19, 23]', truncated: false } }
          : {})
      }))
    }))
    await mount()
    expect(read).toHaveBeenCalledWith({ sourceIds: [] })
    expect(container.querySelectorAll('pre')).toHaveLength(0)
    await toggleSession()
    const details = container.querySelector<HTMLDetailsElement>('details[data-kernel-details]')!
    await act(async () => {
      details.open = true
      details.dispatchEvent(new Event('toggle'))
    })
    expect(read).toHaveBeenLastCalledWith({ sourceIds: ['instance-0'] })
    expect(container.querySelector('code')?.textContent).toBe('values = [19, 23]')
    await toggleSession()
    expect(
      container.querySelectorAll('details[data-kernel-details], pre, table, svg[role="img"]')
    ).toHaveLength(0)
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(read).toHaveBeenLastCalledWith({ sourceIds: [] })
  })

  it('keeps failed cleanup visible and stops polling when unmounted', async () => {
    terminate.mockRejectedValue(new Error('cleanup unverified'))
    await mount()
    await toggleSession()
    await click('Terminate')
    await click('Terminate', container.querySelector('form')!)
    expect(container.textContent).toContain('Process cleanup could not be confirmed')
    expect(totals()).toContain('3 kernels')
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(read).toHaveBeenCalledTimes(3)
    act(() => root.unmount())
    root = { unmount: () => {} } as Root
    await act(async () => vi.advanceTimersByTimeAsync(9000))
    expect(read).toHaveBeenCalledTimes(3)
  })
})
