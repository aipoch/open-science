// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ComputeApprovalRequest } from '../../../../shared/compute'
import { createInitialComputeState, useComputeStore } from '@/stores/compute-store'
import { ComputeApprovalDialog } from './ComputeApprovalDialog'

const request: Extract<ComputeApprovalRequest, { operation: 'call_command' }> = {
  id: 'approval-1',
  operation: 'call_command',
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

  it('keeps a covered approval queued while suppressing its presentation', () => {
    useComputeStore.setState({ pendingApprovals: [request] })

    act(() => root.render(<ComputeApprovalDialog active={false} />))

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(useComputeStore.getState().pendingApprovals).toEqual([request])
  })

  it('keeps approvals for the open Side chat parent queued without showing its dialog', () => {
    useComputeStore.setState({
      pendingApprovals: [{ ...request, session_id: 'session-side' }]
    })

    act(() => root.render(<ComputeApprovalDialog blockedSessionIds={new Set(['session-side'])} />))

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(useComputeStore.getState().pendingApprovals).toHaveLength(1)
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
    expect(dialog?.className).toContain('overflow-hidden')
    expect(dialog?.textContent).toContain('Allow remote command?')
    expect(
      Array.from(document.body.querySelectorAll<HTMLElement>('div')).some((element) =>
        element.className.includes('border-b border-border-300/90 px-5 py-3.5')
      )
    ).toBe(true)
    expect(
      Array.from(document.body.querySelectorAll<HTMLElement>('div')).some((element) =>
        element.className.includes('border-t border-border-300/90 px-5 py-3.5')
      )
    ).toBe(true)
    expect(document.body.textContent).toContain('Research cluster')
    expect(document.body.textContent).toContain('python ...')
  })

  it('shows the remote path instead of an empty command for download approval', () => {
    useComputeStore.setState({
      pendingApprovals: [
        {
          id: 'approval-download',
          operation: 'download',
          provider_id: 'ssh:cluster',
          provider_name: 'Research cluster',
          shape: 'direct_ssh',
          intent: 'Download remote file to session workspace',
          remote_path: '/remote/private/results.csv'
        } as ComputeApprovalRequest
      ]
    })

    act(() => root.render(<ComputeApprovalDialog />))

    const dialogText = document.body.querySelector('[role="dialog"]')?.textContent
    expect(dialogText).toContain('Allow remote file download?')
    expect(dialogText).toContain('Remote path')
    expect(dialogText).toContain('/remote/private/results.csv')
    expect(dialogText).not.toContain('Command')
  })

  it('shows the complete execution envelope for job approval', () => {
    useComputeStore.setState({
      pendingApprovals: [
        {
          id: 'approval-job',
          operation: 'submit_job',
          provider_id: 'ssh:cluster',
          provider_name: 'Research cluster',
          shape: 'scheduler_cluster',
          intent: 'Run the analysis',
          command_preview: 'python analysis.py',
          command_full: 'python analysis.py',
          inputs_summary: '2 input files',
          resources: '{"cpus":4,"memory":"16 GiB"}',
          timeout_seconds: 3600,
          remote_workdir: '/scratch/project/job-1'
        } as ComputeApprovalRequest
      ]
    })

    act(() => root.render(<ComputeApprovalDialog />))

    const dialogText = document.body.querySelector('[role="dialog"]')?.textContent
    expect(dialogText).toContain('Allow remote job submission?')
    expect(dialogText).toContain('Resources')
    expect(dialogText).toContain('{"cpus":4,"memory":"16 GiB"}')
    expect(dialogText).toContain('Timeout')
    expect(dialogText).toContain('3600 seconds')
    expect(dialogText).toContain('Remote workdir')
    expect(dialogText).toContain('/scratch/project/job-1')
  })

  it('warns without blocking approval when job data will be stored unencrypted', () => {
    useComputeStore.setState({
      pendingApprovals: [{ ...request, willPersistUnencrypted: true }]
    })
    act(() => root.render(<ComputeApprovalDialog />))

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      "Secure storage is unavailable. This job's command, paths, and output may be stored without encryption."
    )
    expect(findButton('Once')?.disabled).toBe(false)
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
    ['This session', 'session']
  ] as const)('keeps the %s approval decision', (label, decision) => {
    useComputeStore.setState({ pendingApprovals: [request] })
    act(() => root.render(<ComputeApprovalDialog />))

    act(() => findButton(label)?.click())

    expect(useComputeStore.getState().respondApproval).toHaveBeenCalledWith(request.id, decision)
  })

  it('disables decisions while submitting and keeps a failed response retryable', async () => {
    let rejectResponse!: (error: Error) => void
    const respondApproval = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<void>((_, reject) => {
          rejectResponse = reject
        })
      )
      .mockResolvedValueOnce(undefined)
    useComputeStore.setState({ pendingApprovals: [request], respondApproval })
    act(() => root.render(<ComputeApprovalDialog />))

    act(() => findButton('Once')?.click())

    for (const label of ['Deny', 'Once', 'This session', 'This project', 'Always']) {
      expect(findButton(label)?.disabled).toBe(true)
    }
    expect(document.body.querySelector('[role="dialog"]')?.getAttribute('aria-busy')).toBe('true')

    await act(async () => {
      rejectResponse(new Error('IPC unavailable'))
      await Promise.resolve()
    })

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not submit this approval. Try again.'
    )
    expect(findButton('Once')?.disabled).toBe(false)

    act(() => findButton('Once')?.click())
    expect(respondApproval).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['This project', 'project', 'for this project'],
    ['Always', 'global', 'globally']
  ] as const)('requires confirmation before %s is remembered', (label, decision, scopePhrase) => {
    useComputeStore.setState({ pendingApprovals: [request] })
    act(() => root.render(<ComputeApprovalDialog />))

    act(() => findButton(label)?.click())

    expect(useComputeStore.getState().respondApproval).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="alertdialog"]')?.textContent).toContain(scopePhrase)

    act(() =>
      document.body
        .querySelector<HTMLButtonElement>('[data-testid="permission-scope-confirm"]')
        ?.click()
    )

    expect(useComputeStore.getState().respondApproval).toHaveBeenCalledWith(request.id, decision)
  })

  it('drops a broad-scope confirmation when its approval settles', () => {
    const nextRequest = { ...request, id: 'approval-2' }
    useComputeStore.setState({ pendingApprovals: [request] })
    act(() => root.render(<ComputeApprovalDialog />))
    act(() => findButton('This project')?.click())

    act(() => useComputeStore.setState({ pendingApprovals: [nextRequest] }))

    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
    expect(useComputeStore.getState().respondApproval).not.toHaveBeenCalled()
  })
})
