// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ComputeApprovalRequest } from '../../../../shared/compute'
import { createInitialComputeState, useComputeStore } from '@/stores/compute-store'
import { ComputeApprovalDialog } from './ComputeApprovalDialog'

const request: ComputeApprovalRequest = {
  id: 'approval-1',
  provider_id: 'ssh:cluster',
  provider_name: 'Research cluster',
  shape: 'direct_ssh',
  intent: 'Inspect the remote environment',
  command_preview: 'python ...',
  command_full: 'python --version && pip list'
}

let container: HTMLDivElement
let root: Root

const findButton = (label: string): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.trim() === label
  )

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useComputeStore.setState({
    ...createInitialComputeState(),
    respondApproval: vi.fn().mockResolvedValue(undefined)
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('ComputeApprovalDialog', () => {
  it('renders nothing without a pending approval', () => {
    act(() => root.render(<ComputeApprovalDialog />))

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('uses shared dialog chrome while preserving the approval content', () => {
    useComputeStore.setState({ pendingApprovals: [request] })
    act(() => root.render(<ComputeApprovalDialog />))

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
    const overlay = Array.from(document.body.querySelectorAll<HTMLElement>('div')).find((element) =>
      element.className.includes('bg-black/50')
    )

    expect(overlay?.className).toContain('data-[state=open]:fade-in-0')
    expect(dialog?.className).toContain('data-[state=open]:zoom-in-95')
    expect(dialog?.className).toContain('z-[60]')
    expect(document.body.textContent).toContain('Research cluster')
    expect(document.body.textContent).toContain('python ...')
  })

  it('shows the full command without changing approval state', () => {
    useComputeStore.setState({ pendingApprovals: [request] })
    act(() => root.render(<ComputeApprovalDialog />))

    act(() => findButton('Show full command')?.click())

    expect(document.body.textContent).toContain('python --version && pip list')
    expect(useComputeStore.getState().respondApproval).not.toHaveBeenCalled()
  })

  it('collapses the command when the approval queue advances to a new request', () => {
    const nextRequest: ComputeApprovalRequest = {
      ...request,
      id: 'approval-2',
      command_preview: 'Rscript ...',
      command_full: 'Rscript analysis.R --all'
    }
    useComputeStore.setState({ pendingApprovals: [request] })
    act(() => root.render(<ComputeApprovalDialog />))
    act(() => findButton('Show full command')?.click())

    act(() => useComputeStore.setState({ pendingApprovals: [nextRequest] }))

    expect(document.body.textContent).toContain('Rscript ...')
    expect(document.body.textContent).not.toContain('Rscript analysis.R --all')
    expect(findButton('Show full command')).toBeDefined()
  })

  it.each([
    ['Deny', 'deny'],
    ['Once', 'once'],
    ['This conversation', 'conversation'],
    ['This project', 'project']
  ] as const)('keeps the %s approval decision', (label, decision) => {
    useComputeStore.setState({ pendingApprovals: [request] })
    act(() => root.render(<ComputeApprovalDialog />))

    act(() => findButton(label)?.click())

    expect(useComputeStore.getState().respondApproval).toHaveBeenCalledWith(request.id, decision)
  })
})
