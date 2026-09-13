// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SkillMarketplaceBatchControls } from './SkillMarketplaceBatch'
import type { SkillMarketplaceBatch } from '../../../../shared/skill-marketplace'

const running: SkillMarketplaceBatch = {
  id: 'batch',
  snapshotId: 'a'.repeat(64),
  status: 'running',
  items: [
    { id: 'one', version: '1.0.0', expectedVersion: null, status: 'installing' },
    { id: 'two', version: '2.0.0', expectedVersion: '1.0.0', status: 'queued' }
  ]
}
const get = vi.fn()
const start = vi.fn()
const stop = vi.fn()
const changed = vi.fn()
const busy = vi.fn()
const clear = vi.fn()
const open = vi.fn()
const exit = vi.fn()
let container: HTMLDivElement
let root: Root
const render = async (expanded = true): Promise<void> => {
  await act(async () =>
    root.render(
      <SkillMarketplaceBatchControls
        expanded={expanded}
        heading={<h3>Marketplace</h3>}
        onOpen={open}
        onExit={exit}
        mode={undefined}
        filteredCount={0}
        showSelection={false}
        onModeChange={vi.fn()}
        onSelectFiltered={vi.fn()}
        onClearSelection={clear}
        onBusyChange={busy}
        onChanged={changed}
      />
    )
  )
}
const click = async (label: string, scope: ParentNode = container): Promise<void> => {
  const button = [...scope.querySelectorAll('button')].find((item) => item.textContent === label)
  expect(button, label).toBeDefined()
  await act(async () => button!.click())
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  vi.stubGlobal('api', {
    settings: {
      getSkillMarketplaceBatch: get,
      startSkillMarketplaceBatch: start,
      stopSkillMarketplaceBatch: stop
    }
  })
  get.mockResolvedValue(structuredClone(running))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.resetAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('Marketplace batch progress projection', () => {
  it('shows only a compact entry outside batch mode without stopping or losing the job', async () => {
    await render(false)
    expect(container.textContent).toContain('Batch manage0/2')
    expect(container.querySelector('button')?.firstElementChild?.getAttribute('data-icon')).toBe(
      'inline-start'
    )
    expect(container.querySelector('button')?.firstElementChild?.getAttribute('aria-hidden')).toBe(
      'true'
    )
    expect(container.querySelector('section')).toBeNull()
    await act(async () => container.querySelector('button')!.click())
    expect(open).toHaveBeenCalledOnce()
    await render(true)
    expect(container.textContent).toContain('Batch installation')
    const back = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Back to Marketplace'
    )!
    expect(back.firstElementChild?.classList.contains('lucide-arrow-left')).toBe(true)
    expect(back.firstElementChild?.getAttribute('data-icon')).toBe('inline-start')
    expect(back.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
    await click('Back to Marketplace')
    expect(exit).toHaveBeenCalledOnce()
    await render(false)
    expect(stop).not.toHaveBeenCalled()
    get.mockResolvedValue({
      ...running,
      status: 'completed',
      items: running.items.map((item) => ({ ...item, status: 'succeeded' }))
    })
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(container.textContent).not.toContain('Batch complete')
    expect(container.textContent).not.toContain('2/2')
    expect(changed).toHaveBeenCalledOnce()
    await render(true)
    expect(container.textContent).toContain('Batch complete')
    expect(container.textContent).toContain('2/2')
  })
  it('survives Settings unmount without stopping the job and restores authoritative progress', async () => {
    await render()
    expect(busy).toHaveBeenLastCalledWith(true)
    expect(container.textContent).toContain('0/2')
    await act(async () => root.unmount())
    const calls = get.mock.calls.length
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(get).toHaveBeenCalledTimes(calls)
    expect(stop).not.toHaveBeenCalled()
    get.mockResolvedValue({
      ...running,
      items: [
        { ...running.items[0], status: 'succeeded' },
        { ...running.items[1], status: 'installing' }
      ]
    })
    root = createRoot(container)
    await render()
    expect(container.textContent).toContain('1/2')
    get.mockResolvedValue({
      ...running,
      status: 'completed',
      items: running.items.map((item) => ({ ...item, status: 'succeeded' }))
    })
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(container.textContent).toContain('Batch complete')
    expect(changed).toHaveBeenCalledOnce()
    expect(busy).toHaveBeenLastCalledWith(false)
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(changed).toHaveBeenCalledOnce()
  })
  it('stops using the current job ID and waits for the main process to settle', async () => {
    await render()
    const stopButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Stop after current item'
    )!
    expect(stopButton.classList.contains('ml-auto')).toBe(true)
    stop.mockResolvedValue(true)
    await click('Stop after current item')
    expect(stop).toHaveBeenCalledExactlyOnceWith('batch')
    expect(container.textContent).toContain('Stopping…')
    expect(stopButton.classList.contains('ml-auto')).toBe(true)
    get.mockResolvedValue({
      ...running,
      status: 'stopped',
      items: [
        { ...running.items[0], status: 'succeeded' },
        { ...running.items[1], status: 'stopped' }
      ]
    })
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(container.textContent).toContain('Batch stopped')
    expect(container.textContent).not.toContain('Retry failed items')
  })
  it('retries only failures after confirmation and deduplicates pending submissions', async () => {
    get.mockResolvedValue({
      ...running,
      status: 'completed',
      items: [
        { ...running.items[0], status: 'succeeded' },
        { ...running.items[1], status: 'failed', result: { ok: false, error: 'network' } }
      ]
    })
    await render()
    expect(container.textContent).toContain('Failed: 1')
    expect(changed).toHaveBeenCalledOnce()
    changed.mockClear()
    await click('Retry failed items')
    const dialog = document.querySelector('[data-testid="skill-marketplace-batch-confirm"]')!
    expect(dialog.textContent).toContain('two: 1.0.0 → 2.0.0')
    expect(dialog.textContent).not.toContain('one:')
    let finish!: (value: unknown) => void
    start.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await click('Update selected', dialog)
    await click('Update selected', dialog)
    expect(start).toHaveBeenCalledExactlyOnceWith({
      snapshotId: running.snapshotId,
      items: [{ id: 'two', version: '2.0.0', expectedVersion: '1.0.0' }]
    })
    expect([...dialog.querySelectorAll('button')].every((button) => button.disabled)).toBe(true)
    const calls = get.mock.calls.length
    await act(async () => vi.advanceTimersByTimeAsync(2000))
    expect(get).toHaveBeenCalledTimes(calls)
    await act(async () =>
      finish({
        ok: true,
        value: {
          ...running,
          id: 'retry',
          status: 'completed',
          items: [{ ...running.items[1], status: 'succeeded' }]
        }
      })
    )
    expect(clear).toHaveBeenCalledOnce()
    expect(changed).toHaveBeenCalledOnce()
  })
  it('fails closed when progress is unavailable and recovers on a later read', async () => {
    get.mockRejectedValueOnce(new Error('offline'))
    await render()
    expect(container.textContent).toContain('Could not load installation progress.')
    expect(busy).toHaveBeenLastCalledWith(true)
    get.mockResolvedValue(null)
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(container.textContent).not.toContain('Could not load installation progress.')
    expect(container.querySelector('section')).toBeNull()
    expect(busy).toHaveBeenLastCalledWith(false)
    expect(start).not.toHaveBeenCalled()
  })
  it('refreshes when another client finishes a batch between progress reads', async () => {
    get.mockResolvedValueOnce(null)
    await render()
    get.mockResolvedValue({
      ...running,
      status: 'completed',
      items: running.items.map((item) => ({ ...item, status: 'succeeded' }))
    })
    await act(async () => vi.advanceTimersByTimeAsync(10000))
    expect(changed).toHaveBeenCalledOnce()
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(changed).toHaveBeenCalledOnce()
  })
  it('polls idle state every ten seconds and pauses while hidden', async () => {
    get.mockResolvedValue(null)
    await render()
    await act(async () => vi.advanceTimersByTimeAsync(9000))
    expect(get).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(get).toHaveBeenCalledTimes(2)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    await act(async () => vi.advanceTimersByTimeAsync(60000))
    expect(get).toHaveBeenCalledTimes(2)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(get).toHaveBeenCalledTimes(3)
  })
  it('dismisses completed results without mutating the queue or reopening on the next poll', async () => {
    get.mockResolvedValue({
      ...running,
      status: 'completed',
      items: running.items.map((item) => ({ ...item, status: 'succeeded' }))
    })
    await render()
    expect(container.querySelector('[data-slot="skill-marketplace-batch-dock"]')).not.toBeNull()
    const done = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Done'
    )
    expect(done?.classList.contains('ml-auto')).toBe(true)
    await click('Done')
    expect(container.querySelector('[data-slot="skill-marketplace-batch-dock"]')).toBeNull()
    await act(async () => vi.advanceTimersByTimeAsync(10000))
    expect(container.querySelector('[data-slot="skill-marketplace-batch-dock"]')).toBeNull()
    expect(stop).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(changed).toHaveBeenCalledOnce()
  })
})
