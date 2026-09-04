// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  admitMessage: vi.fn(),
  error: undefined as string | undefined,
  retry: vi.fn(),
  useJobAnalysisEffect: vi.fn()
}))

vi.mock('@/pages/workspace/workspace-message-queue-controller', () => ({
  useWorkspaceApplicationMessageAdmission: () => mocks.admitMessage
}))

vi.mock('./useJobAnalysisEffect', () => ({
  useJobAnalysisEffect: (options: unknown) => {
    mocks.useJobAnalysisEffect(options)
    return { error: mocks.error, retry: mocks.retry }
  }
}))

import { WorkspaceComputeRecoveryBridge } from './WorkspaceComputeRecoveryBridge'

afterEach(() => {
  cleanup()
  mocks.error = undefined
  mocks.retry.mockReset()
  mocks.useJobAnalysisEffect.mockReset()
})

describe('WorkspaceComputeRecoveryBridge', () => {
  it('stays hidden while recovery is healthy', () => {
    render(<WorkspaceComputeRecoveryBridge enabled />)

    expect(screen.queryByRole('alert')).toBeNull()
    expect(mocks.useJobAnalysisEffect).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, admitMessage: mocks.admitMessage })
    )
  })

  it('surfaces a retryable recovery failure', () => {
    mocks.error = 'database busy'
    render(<WorkspaceComputeRecoveryBridge enabled />)

    expect(screen.getByRole('alert').textContent).toContain('Remote job recovery needs attention')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(mocks.retry).toHaveBeenCalledOnce()
  })
})
