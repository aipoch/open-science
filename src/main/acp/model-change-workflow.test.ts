import { describe, expect, it, type Mock, vi } from 'vitest'

import type { AgentModelChangeTarget } from '../agent-framework'
import { AcpModelChangeWorkflow } from './model-change-workflow'

const target = (model: string): AgentModelChangeTarget => ({
  frameworkId: 'claude-code',
  backendId: 'claude-code:provider',
  route: 'claude-anthropic',
  model,
  sessionModel: model,
  sessionModelRequired: false,
  reasoningEffort: 'default',
  supportsImageInput: false
})

type WorkflowHarness = {
  workflow: AcpModelChangeWorkflow
  canApply: Mock<(target: AgentModelChangeTarget) => boolean>
  matchesCurrent: Mock<(target: AgentModelChangeTarget) => boolean>
  applyTarget: Mock<(target: AgentModelChangeTarget) => Promise<boolean>>
  requestReconnect: Mock<() => Promise<void>>
  recoverFailedReconnect: Mock<() => void>
  reportReconnectFailure: Mock<(error: unknown) => void>
  setBusy: (value: boolean) => void
}

const createHarness = (): WorkflowHarness => {
  let busy = false
  const canApply = vi.fn(() => true)
  const matchesCurrent = vi.fn(() => false)
  const applyTarget = vi.fn(async () => true)
  const requestReconnect = vi.fn(async () => undefined)
  const recoverFailedReconnect = vi.fn()
  const reportReconnectFailure = vi.fn()
  const workflow = new AcpModelChangeWorkflow({
    canApply,
    matchesCurrent,
    isGenerationBusy: () => busy,
    applyTarget,
    requestReconnect,
    recoverFailedReconnect,
    reportReconnectFailure
  })
  return {
    workflow,
    canApply,
    matchesCurrent,
    applyTarget,
    requestReconnect,
    recoverFailedReconnect,
    reportReconnectFailure,
    setBusy: (value: boolean) => {
      busy = value
    }
  }
}

describe('ACP model-change workflow', () => {
  it('rejects an incompatible target without arming admission', async () => {
    const harness = createHarness()
    harness.canApply.mockReturnValue(false)

    await expect(harness.workflow.apply(target('model-b'))).resolves.toBe(false)

    expect(harness.workflow.barrier).toBeUndefined()
    expect(harness.applyTarget).not.toHaveBeenCalled()
  })

  it('keeps only the latest target while the generation is busy', async () => {
    const harness = createHarness()
    harness.setBusy(true)

    await harness.workflow.apply(target('model-b'))
    await harness.workflow.apply(target('model-c'))
    expect(harness.applyTarget).not.toHaveBeenCalled()
    expect(harness.workflow.barrier).toBeDefined()

    harness.setBusy(false)
    harness.workflow.activityChanged()
    await harness.workflow.barrier

    expect(harness.applyTarget).toHaveBeenCalledOnce()
    expect(harness.applyTarget).toHaveBeenCalledWith(target('model-c'))
    expect(harness.workflow.barrier).toBeUndefined()
  })

  it('cancels a pending target when the current target is selected again', async () => {
    const harness = createHarness()
    harness.setBusy(true)
    await harness.workflow.apply(target('model-b'))
    harness.matchesCurrent.mockReturnValue(true)
    harness.setBusy(false)

    await expect(harness.workflow.apply(target('model-a'))).resolves.toBe(true)

    expect(harness.workflow.barrier).toBeUndefined()
    expect(harness.applyTarget).not.toHaveBeenCalled()
  })

  it('falls back to reconnect and recovers a failed reconnect before releasing admission', async () => {
    const harness = createHarness()
    const failure = new Error('reconnect failed')
    harness.applyTarget.mockResolvedValue(false)
    harness.requestReconnect.mockRejectedValue(failure)

    await expect(harness.workflow.apply(target('model-b'))).resolves.toBe(true)

    expect(harness.requestReconnect).toHaveBeenCalledOnce()
    expect(harness.reportReconnectFailure).toHaveBeenCalledWith(failure)
    expect(harness.recoverFailedReconnect).toHaveBeenCalledOnce()
    expect(harness.workflow.barrier).toBeUndefined()
  })
})
