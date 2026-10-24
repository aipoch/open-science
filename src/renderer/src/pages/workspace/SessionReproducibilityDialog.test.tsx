// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { expect, it, vi, type Mock } from 'vitest'
import type { ChatSession } from '@/stores/session-store'
import type {
  SessionReproducibilityBatch,
  SessionReproducibilityCommand
} from '../../../../shared/session-reproducibility'
import { SessionReproducibilityDialog } from './SessionReproducibilityDialog'
import { useDesktopRuntimeRecoveryStore } from '@/stores/desktop-runtime-recovery-store'
import type { NotebookRunRecord } from '../../../../shared/notebook'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const session: ChatSession = {
  id: 's',
  projectId: 'p',
  title: 'Analysis',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1
}
const target = { artifactId: 'a', versionId: 'v1', name: 'result.csv' }
const ready: SessionReproducibilityBatch = {
  ...{ projectId: 'p', appSessionId: 's' },
  batchId: 'batch',
  createdAt: new Date().toISOString(),
  status: 'ready',
  targets: [{ ...target, status: 'queued' }]
}

it('pins the selected version, requires preflight and keeps the running batch on reopen', async () => {
  let batch: SessionReproducibilityBatch | undefined
  const command = vi.fn(async (request: SessionReproducibilityCommand) => {
    if (request.action === 'prepare') batch = structuredClone(ready)
    if (request.action === 'start')
      batch = { ...ready, status: 'running', targets: [{ ...target, status: 'running' }] }
    return batch
  })
  const readExportFiles = vi.fn().mockResolvedValue([
    {
      id: 'item',
      source: 'artifact',
      sourceFileId: 'a',
      sourceVersionId: 'v1',
      name: 'result.csv',
      size: 20
    }
  ])
  ;(window as unknown as { api: unknown }).api = {
    artifacts: { sessionReproducibility: command },
    projectFiles: {
      getOverview: vi.fn().mockResolvedValue({ isIndexComplete: true }),
      readExportFiles,
      repairIndex: vi.fn()
    }
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container),
    onClose = vi.fn()
  const button = (text: string): HTMLButtonElement =>
    [...document.querySelectorAll('button')].find((el) => el.textContent === text)!
  try {
    await act(async () =>
      root.render(<SessionReproducibilityDialog session={session} onClose={onClose} />)
    )
    await act(async () => fireEvent.click(button('Check readiness')))
    expect(command).toHaveBeenCalledWith({
      projectId: 'p',
      appSessionId: 's',
      action: 'prepare',
      targets: [target]
    })
    await act(async () => fireEvent.click(button('Check reproducibility')))
    expect(command).toHaveBeenCalledWith({
      projectId: 'p',
      appSessionId: 's',
      action: 'start',
      batchId: 'batch'
    })
    await act(async () => root.render(<SessionReproducibilityDialog onClose={onClose} />))
    expect(command.mock.calls.some(([request]) => request.action === 'cancel')).toBe(false)
    readExportFiles.mockRejectedValueOnce(new Error('index unavailable'))
    await act(async () =>
      root.render(<SessionReproducibilityDialog session={session} onClose={onClose} />)
    )
    expect(document.body.textContent).toContain('Checking…')
    expect(document.querySelector('[role="alert"]')).not.toBeNull()
    expect(button('Cancel').disabled).toBe(false)
    await act(async () => fireEvent.click(button('Cancel')))
    expect(command).toHaveBeenLastCalledWith({
      projectId: 'p',
      appSessionId: 's',
      action: 'cancel',
      batchId: 'batch'
    })
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})

const executionData = {
  execution: {
    reproducibility: {
      activities: [
        { activityId: 'prepare', kind: 'notebook-run', runIndex: 0 },
        { activityId: 'plot', kind: 'notebook-run', runIndex: 1 }
      ],
      entities: [{ entityId: 'intermediate' }],
      startFrontiers: [
        {
          frontierId: 'checkpoint:prepare',
          kind: 'checkpoint',
          eligibility: 'available',
          afterActivityId: 'prepare',
          crossingEntityIds: ['intermediate'],
          downstreamActivityIds: ['plot']
        },
        {
          frontierId: 'checkpoint:memory',
          kind: 'checkpoint',
          eligibility: 'blocked',
          crossingEntityIds: [],
          downstreamActivityIds: ['plot']
        }
      ]
    }
  }
}
const execution = (): typeof executionData => structuredClone(executionData)

type StartingPointsView = {
  command: Mock<
    (request: SessionReproducibilityCommand) => Promise<SessionReproducibilityBatch | undefined>
  >
  getVersionExecution: Mock
  render: (value?: ChatSession) => Promise<void>
  button: (name: string) => HTMLButtonElement
  openStarts: () => Promise<void>
  chooseCheckpoint: () => Promise<void>
  cleanup: () => Promise<void>
}

const setupStartingPoints = (): StartingPointsView => {
  const command = vi.fn(async (request: SessionReproducibilityCommand) => {
    if (request.action === 'prepare')
      return {
        ...ready,
        targets: request.targets.map((row) => ({ ...row, status: 'queued' as const, steps: 1 }))
      }
    return undefined
  })
  const getVersionExecution = vi.fn().mockResolvedValue(execution())
  ;(window as unknown as { api: unknown }).api = {
    artifacts: { sessionReproducibility: command, getVersionExecution },
    projectFiles: {
      getOverview: vi.fn().mockResolvedValue({ isIndexComplete: true }),
      readExportFiles: vi.fn().mockResolvedValue([
        {
          id: 'item',
          source: 'artifact',
          sourceFileId: 'a',
          sourceVersionId: 'v1',
          name: 'result.csv',
          size: 20
        }
      ]),
      repairIndex: vi.fn()
    }
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = async (value: ChatSession = session): Promise<void> => {
    await act(async () =>
      root.render(<SessionReproducibilityDialog session={value} onClose={vi.fn()} />)
    )
  }
  const button = (name: string): HTMLButtonElement =>
    [...document.querySelectorAll('button')].find((el) => el.textContent === name)!
  const openStarts = async (): Promise<void> => {
    await act(async () =>
      fireEvent.click(document.querySelector('[aria-label="Starting point for {{name}}"]')!)
    )
  }
  const chooseCheckpoint = async (): Promise<void> => {
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? ((): void => {})
    await act(async () =>
      fireEvent.keyDown(document.querySelector('[data-slot="select-trigger"]')!, {
        key: 'ArrowDown'
      })
    )
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(2)
    const choice = document.querySelector('[role="option"][data-state="unchecked"]')!
    await act(async () => fireEvent.click(choice))
  }
  const cleanup = async (): Promise<void> => {
    await act(async () => root.unmount())
    container.remove()
  }
  return { command, getVersionExecution, render, button, openStarts, chooseCheckpoint, cleanup }
}

it('loads safe saved starts on demand, pins the choice at preflight, and keeps it when changing selection', async () => {
  const view = setupStartingPoints()
  try {
    await view.render()
    expect(view.getVersionExecution).not.toHaveBeenCalled()
    await view.openStarts()
    expect(view.getVersionExecution).toHaveBeenCalledWith({
      projectId: 'p',
      appSessionId: 's',
      artifactId: 'a',
      versionId: 'v1'
    })
    await view.chooseCheckpoint()
    expect(document.body.textContent).toContain('Downstream-only claim')
    expect(document.body.textContent).toContain('Upstream steps are not checked.')
    expect(view.command.mock.calls.some(([request]) => request.action === 'prepare')).toBe(false)
    await act(async () => fireEvent.click(view.button('Check readiness')))
    expect(view.command).toHaveBeenLastCalledWith({
      projectId: 'p',
      appSessionId: 's',
      action: 'prepare',
      targets: [{ ...target, frontierId: 'checkpoint:prepare' }]
    })
    expect(document.body.textContent).toContain('Downstream-only claim')
    await act(async () => fireEvent.click(view.button('Change selection')))
    await act(async () => fireEvent.click(view.button('Check readiness')))
    expect(view.command).toHaveBeenLastCalledWith(
      expect.objectContaining({
        targets: [{ ...target, frontierId: 'checkpoint:prepare' }]
      })
    )
  } finally {
    await view.cleanup()
  }
})

it('reports unavailable saved starts without claiming partial execution', async () => {
  const view = setupStartingPoints()
  view.getVersionExecution.mockResolvedValueOnce({ execution: undefined })
  try {
    await view.render()
    await view.openStarts()
    expect(document.body.textContent).toContain(
      'No saved intermediate results are available for this version.'
    )
    expect(document.querySelector('[data-slot="select-trigger"]')).toBeNull()
    await act(async () => fireEvent.click(view.button('Check readiness')))
    expect(view.command).toHaveBeenLastCalledWith(expect.objectContaining({ targets: [target] }))
  } finally {
    await view.cleanup()
  }
})

it('retries failed checkpoint reads without resetting the persisted starting point', async () => {
  const view = setupStartingPoints()
  view.command.mockResolvedValueOnce({
    ...ready,
    targets: [{ ...target, status: 'queued', frontierId: 'checkpoint:prepare' }]
  })
  view.getVersionExecution.mockResolvedValueOnce({
    failure: { kind: 'integrity-failed', message: 'checksum mismatch' }
  })
  try {
    await view.render()
    expect(document.body.textContent).toContain('Starting points could not be loaded. Try again.')
    expect(document.body.textContent).toContain('Downstream-only claim')
    await act(async () => fireEvent.click(view.button('Retry')))
    expect(view.getVersionExecution).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).not.toContain(
      'Starting points could not be loaded. Try again.'
    )
    await act(async () => fireEvent.click(view.button('Change selection')))
    expect(document.body.textContent).toContain('Downstream-only claim')
    await act(async () => fireEvent.click(view.button('Check readiness')))
    expect(view.command).toHaveBeenLastCalledWith(
      expect.objectContaining({
        targets: [{ ...target, frontierId: 'checkpoint:prepare' }]
      })
    )
  } finally {
    await view.cleanup()
  }
})

it('ignores a late checkpoint read after switching sessions', async () => {
  const view = setupStartingPoints()
  let resolve!: (value: ReturnType<typeof execution>) => void
  view.getVersionExecution.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  try {
    await view.render()
    await view.openStarts()
    await view.render({ ...session, id: 'other' })
    await act(async () => resolve(execution()))
    expect(document.querySelector('[data-slot="select-trigger"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Downstream-only claim')
    await act(async () => fireEvent.click(view.button('Check readiness')))
    expect(view.command).toHaveBeenLastCalledWith(
      expect.objectContaining({ appSessionId: 'other', targets: [target] })
    )
  } finally {
    await view.cleanup()
  }
})

const workflow = {
  state: 'available' as const,
  captureId: 'c'.repeat(64),
  stages: [0, 1, 2].map((runIndex) => ({
    runId: `run-${runIndex}`,
    runIndex,
    kernelKind: 'python' as const,
    outputCount: runIndex === 2 ? 0 : 1
  })),
  boundaries: [
    { entityId: 'frozen', relativePath: 'counts.csv', checksum: 'f'.repeat(64), sizeBytes: 10 }
  ]
}
const chooseWorkflow = async (): Promise<void> => {
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? ((): void => {})
  await act(async () =>
    fireEvent.keyDown(document.querySelector('[data-slot="select-trigger"]')!, { key: 'ArrowDown' })
  )
  await act(async () =>
    fireEvent.click(
      [...document.querySelectorAll('[role="option"]')].find(
        (option) => option.textContent === 'Workflow stages'
      )!
    )
  )
}
const workflowChecks = (): HTMLInputElement[] => [
  ...document.querySelectorAll<HTMLInputElement>('fieldset input[type="checkbox"]')
]

it('requests R endpoints for dependency-closure planning', async () => {
  const view = setupStartingPoints()
  view.getVersionExecution.mockResolvedValue({
    execution: {
      ...execution().execution,
      workflow: {
        ...workflow,
        stages: workflow.stages.map((stage) => ({ ...stage, kernelKind: 'r' }))
      }
    }
  })
  try {
    await view.render()
    await view.openStarts()
    await chooseWorkflow()
    await act(async () => fireEvent.click(workflowChecks()[1]!))
    await act(async () => fireEvent.click(view.button('Check readiness')))
    expect(view.command).toHaveBeenLastCalledWith(
      expect.objectContaining({
        targets: [
          expect.objectContaining({
            workflow: expect.objectContaining({
              targetRunIds: ['run-1', 'run-2']
            })
          })
        ]
      })
    )
  } finally {
    await view.cleanup()
  }
})

it('pins arbitrary captured runs and frozen boundaries, supports a continuous range and rejects empty stages', async () => {
  const view = setupStartingPoints()
  view.getVersionExecution.mockResolvedValue({ execution: { ...execution().execution, workflow } })
  try {
    await view.render()
    await view.openStarts()
    await chooseWorkflow()
    expect(document.body.textContent).toContain('Captured stages through this Artifact Version')
    expect(workflowChecks().map((input) => input.checked)).toEqual([false, false, true, false])
    await act(async () => fireEvent.click(workflowChecks()[0]!))
    await act(async () => fireEvent.click(workflowChecks()[3]!))
    await act(async () => fireEvent.click(view.button('Check readiness')))
    expect(view.command).toHaveBeenLastCalledWith(
      expect.objectContaining({
        targets: [
          {
            ...target,
            frontierId: 'workflow-selection',
            workflow: {
              captureId: workflow.captureId,
              targetRunIds: ['run-0', 'run-2'],
              boundaryEntityIds: ['frozen']
            }
          }
        ]
      })
    )
    expect(document.body.textContent).not.toContain('End-to-end claim')
    await act(async () => fireEvent.click(view.button('Change selection')))
    expect(workflowChecks().map((input) => input.checked)).toEqual([true, false, true, true])
    await act(async () =>
      fireEvent.change(document.querySelector('[aria-label="First captured stage"]')!, {
        target: { value: 'run-1' }
      })
    )
    await act(async () => fireEvent.click(view.button('Select range')))
    expect(workflowChecks().map((input) => input.checked)).toEqual([false, true, true, true])
    await act(async () => fireEvent.click(workflowChecks()[1]!))
    await act(async () => fireEvent.click(workflowChecks()[2]!))
    expect(view.button('Check readiness').disabled).toBe(true)
    expect(document.body.textContent).toContain('Select at least one captured stage.')
  } finally {
    await view.cleanup()
  }
})

it('restores a saved workflow selection after a failed metadata read without falling back to an Artifact start', async () => {
  const view = setupStartingPoints()
  const selection = {
    captureId: workflow.captureId,
    targetRunIds: ['run-1'],
    boundaryEntityIds: ['frozen']
  }
  view.command.mockResolvedValueOnce({
    ...ready,
    targets: [
      { ...target, frontierId: 'workflow-selection', workflow: selection, status: 'queued' }
    ]
  })
  view.getVersionExecution.mockRejectedValueOnce(new Error('read unavailable'))
  view.getVersionExecution.mockResolvedValue({ execution: { ...execution().execution, workflow } })
  try {
    await view.render()
    expect(document.body.textContent).toContain('Starting points could not be loaded. Try again.')
    await act(async () => fireEvent.click(view.button('Change selection')))
    expect(workflowChecks().map((input) => input.checked)).toEqual([false, true, false, true])
    await act(async () => fireEvent.click(view.button('Check readiness')))
    expect(view.command).toHaveBeenLastCalledWith(
      expect.objectContaining({
        targets: [{ ...target, frontierId: 'workflow-selection', workflow: selection }]
      })
    )
  } finally {
    await view.cleanup()
  }
})

it('shows execution-only batch completion without claiming reproduced outputs', async () => {
  const view = setupStartingPoints()
  view.command.mockResolvedValueOnce({
    ...ready,
    status: 'completed',
    targets: [{ ...target, status: 'executed' }]
  })
  try {
    await view.render()
    expect(document.body.textContent).toContain('Executed (outputs not fully verified)')
    expect(document.body.textContent).not.toContain('Result reproduced')
    expect(document.body.textContent).not.toContain('Results differ')
  } finally {
    await view.cleanup()
  }
})

it.each(['matched', 'different'] as const)(
  'limits workflow batch %s conclusions to the compared outputs',
  async (status) => {
    const view = setupStartingPoints()
    view.command.mockResolvedValueOnce({
      ...ready,
      status: 'completed',
      targets: [
        {
          ...target,
          status,
          frontierId: 'workflow-selection',
          workflow: {
            captureId: workflow.captureId,
            targetRunIds: ['run-0'],
            boundaryEntityIds: []
          }
        }
      ]
    })
    view.getVersionExecution.mockResolvedValue({
      execution: { ...execution().execution, workflow }
    })
    try {
      await view.render()
      expect(document.body.textContent).toContain(
        status === 'matched' ? 'Compared outputs reproduced' : 'Compared outputs differ'
      )
      expect(document.body.textContent).toContain('Selected captured runs: {{runs}}')
      expect(document.body.textContent).not.toContain('Result reproduced')
      expect(document.body.textContent).not.toContain('Results differ')
    } finally {
      await view.cleanup()
    }
  }
)

const selectedRun = {
  runId: 'run-7',
  kernelKind: 'r',
  status: 'completed',
  kernelEpochId: 'epoch',
  script: 'answer <- nrow(data)',
  environmentLock: { state: 'available', format: 'environment-lock-bundle', lockChecksum: 'lock' }
} as NotebookRunRecord
const selectedWorkflow = {
  captureId: 'a'.repeat(64),

  targetRunIds: ['run-7'],
  boundaryEntityIds: []
}
const selectedTarget = {
  ...target,
  frontierId: 'workflow-selection',
  workflow: selectedWorkflow
}

type StepView = {
  command: Mock<
    (request: SessionReproducibilityCommand) => Promise<SessionReproducibilityBatch | undefined>
  >
  getVersionExecution: Mock
  render: (value?: ChatSession, disabled?: boolean) => Promise<void>
  button: (label: string) => HTMLButtonElement
  cleanup: () => Promise<void>
}
const setupStep = (initial?: SessionReproducibilityBatch): StepView => {
  useDesktopRuntimeRecoveryStore.setState({ phase: 'connected', epoch: 0, closing: false })
  let batch = initial
  const command = vi.fn(async (request: SessionReproducibilityCommand) => {
    if (request.action === 'prepare')
      batch = {
        ...ready,
        targets: request.targets.map((row) => ({
          ...row,
          status: 'queued',
          steps: 1,
          inputBytes: 12,
          environmentCount: 1
        }))
      }
    if (request.action === 'start')
      batch = {
        ...batch!,
        status: 'running',
        targets: batch!.targets.map((row) => ({ ...row, status: 'running' }))
      }
    if (request.action === 'cancel')
      batch = {
        ...batch!,
        status: 'cancelled',
        targets: batch!.targets.map((row) => ({ ...row, status: 'cancelled' }))
      }
    return batch
  })
  const getVersionExecution = vi.fn().mockResolvedValue({
    execution: {
      runs: [{ ...structuredClone(selectedRun), runIndex: 6, environmentName: 'r-analysis' }],
      workflow: {
        state: 'available',
        captureId: selectedWorkflow.captureId,
        stages: [{ runId: selectedRun.runId, runIndex: 6, kernelKind: 'r', outputCount: 1 }],
        boundaries: []
      }
    }
  })
  ;(window as unknown as { api: unknown }).api = {
    artifacts: { sessionReproducibility: command, getVersionExecution },
    projectFiles: {
      getOverview: vi.fn().mockResolvedValue({ isIndexComplete: true }),
      repairIndex: vi.fn(),
      readExportFiles: vi.fn().mockResolvedValue([
        {
          id: 'item',
          source: 'artifact',
          sourceFileId: 'a',
          sourceVersionId: 'v1',
          name: 'result.csv',
          size: 20
        }
      ])
    }
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = async (value?: ChatSession, disabled = false): Promise<void> => {
    await act(async () =>
      root.render(
        <SessionReproducibilityDialog
          session={value}
          run={selectedRun}
          disabled={disabled}
          onClose={vi.fn()}
        />
      )
    )
  }
  const button = (label: string): HTMLButtonElement =>
    [...document.querySelectorAll('button')].find((node) => node.textContent === label)!
  return {
    command,
    getVersionExecution,
    render,
    button,
    cleanup: async () => {
      await act(async () => root.unmount())
      container.remove()
    }
  }
}

it('previews the captured R source and prepares its pinned target with dependencies', async () => {
  const view = setupStep()
  try {
    await view.render(session)
    expect(document.body.textContent).toContain('reruns the required upstream cells')
    expect(document.body.textContent).toContain('r-analysis')
    expect(document.querySelector('input[type="checkbox"]')).toBeNull()
    await act(async () => fireEvent.click(view.button('Check readiness')))
    expect(view.command).toHaveBeenLastCalledWith({
      projectId: 'p',
      appSessionId: 's',
      action: 'prepare',
      targets: [selectedTarget]
    })
    expect(document.body.textContent).toContain('Runs to execute')
    await act(async () => fireEvent.click(view.button('Check reproducibility')))
    expect(view.command).toHaveBeenLastCalledWith({
      projectId: 'p',
      appSessionId: 's',
      action: 'start',
      batchId: 'batch'
    })
    await view.render()
    expect(view.command.mock.calls.some(([request]) => request.action === 'cancel')).toBe(false)
    await view.render(session)
    await act(async () => fireEvent.click(view.button('Cancel')))
    expect(view.command).toHaveBeenLastCalledWith({
      projectId: 'p',
      appSessionId: 's',
      action: 'cancel',
      batchId: 'batch'
    })
  } finally {
    await view.cleanup()
  }
})

it('starts a dependency plan that includes multiple upstream runs', async () => {
  const view = setupStep({
    ...ready,
    targets: [{ ...selectedTarget, status: 'queued', steps: 2 }]
  })
  try {
    await view.render(session)
    expect(view.button('Check reproducibility').disabled).toBe(false)
    await act(async () => view.button('Check reproducibility').click())
    expect(view.command).toHaveBeenCalledWith(expect.objectContaining({ action: 'start' }))
  } finally {
    await view.cleanup()
  }
})

it.each([
  { ...target, workflow: { ...selectedWorkflow, captureId: 'b'.repeat(64) } },
  { ...selectedTarget, versionId: 'another-version' },
  { ...target, workflow: { ...selectedWorkflow, targetRunIds: ['another-run'] } }
])('does not start, replace or cancel a foreign running batch', async (foreignTarget) => {
  const view = setupStep({
    ...ready,
    status: 'running',
    targets: [{ ...foreignTarget, status: 'running' }]
  })
  try {
    await view.render(session)
    expect(document.body.textContent).toContain('Another session check is active.')
    expect(view.button('Cancel')).toBeUndefined()
    expect(view.button('Check reproducibility')).toBeUndefined()
    expect(view.button('Check readiness').disabled).toBe(true)
    expect(view.command.mock.calls.every(([request]) => request.action === 'get')).toBe(true)
  } finally {
    await view.cleanup()
  }
})

it('reports missing exact capture without preparing another run and disables recovery writes', async () => {
  const view = setupStep()
  view.getVersionExecution.mockResolvedValueOnce({
    execution: {
      runs: [],
      workflow: { state: 'available', captureId: selectedWorkflow.captureId, stages: [] }
    }
  })
  try {
    await view.render(session)
    expect(document.body.textContent).toContain('No frozen capture is available for this run.')
    expect(view.button('Check readiness').disabled).toBe(true)
    await view.render()
    await view.render(session, true)
    expect(view.button('Check readiness').disabled).toBe(true)
    expect(document.body.textContent).toContain('read-only, busy or recovering')
  } finally {
    await view.cleanup()
  }
})

it('ignores a late frozen capture read after switching sessions', async () => {
  const view = setupStep()
  let resolveOld!: (value: unknown) => void
  view.getVersionExecution.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve
      })
  )
  try {
    await view.render(session)
    await view.render({ ...session, id: 'other', title: 'Other session' })
    await act(async () =>
      resolveOld({ execution: { runs: [], workflow: { state: 'unavailable' } } })
    )
    expect(document.body.textContent).toContain('Other session')
    expect(document.body.textContent).not.toContain('No frozen capture is available for this run.')
    await act(async () => fireEvent.click(view.button('Check readiness')))
    expect(view.command).toHaveBeenLastCalledWith({
      projectId: 'p',
      appSessionId: 'other',
      action: 'prepare',
      targets: [selectedTarget]
    })
  } finally {
    await view.cleanup()
  }
})

it('loads the exact batch receipt from later history pages and renders file comparisons', async () => {
  const checksum = 'receipt-checksum'
  const view = setupStep({
    ...ready,
    status: 'completed',
    targets: [{ ...selectedTarget, status: 'matched', receiptChecksum: checksum }]
  })
  const readReceipts = vi
    .fn()
    .mockResolvedValueOnce({ receipts: [], nextCursor: 'older' })
    .mockResolvedValueOnce({
      receipts: [
        {
          receiptChecksum: checksum,
          artifactVersion: { projectId: 'p', appSessionId: 's', artifactId: 'a', versionId: 'v1' },
          comparisons: [
            {
              entityId: 'file:result',
              stepId: 'run-7',
              relativePath: 'result.csv',
              status: 'matched',
              expectedSizeBytes: 0
            }
          ]
        }
      ]
    })
  Object.assign(window.api.artifacts, { listReproducibilityReceipts: readReceipts })
  try {
    await view.render(session)
    expect(readReceipts).toHaveBeenNthCalledWith(2, {
      projectId: 'p',
      appSessionId: 's',
      artifactId: 'a',
      versionId: 'v1',
      cursor: 'older'
    })
    expect(document.body.textContent).toContain('result.csv')
    expect(document.body.textContent).toContain('Compared outputs reproduced')
    expect(document.body.textContent).toContain('Original output')
    expect(view.button('View output')).toBeUndefined()
  } finally {
    await view.cleanup()
  }
})

it('ignores old-epoch command completion and reloads only after the connection recovers', async () => {
  const view = setupStep()
  let resolvePrepare!: (value: SessionReproducibilityBatch) => void
  try {
    await view.render(session)
    view.command.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePrepare = resolve
        })
    )
    await act(async () => fireEvent.click(view.button('Check readiness')))
    const readsBeforeRecovery = view.getVersionExecution.mock.calls.length
    await act(async () =>
      useDesktopRuntimeRecoveryStore.setState({ epoch: 1, phase: 'disconnected' })
    )
    await act(async () =>
      resolvePrepare({ ...ready, targets: [{ ...selectedTarget, status: 'queued', steps: 1 }] })
    )
    expect(view.button('Check reproducibility')).toBeUndefined()
    expect(view.button('Preparing…').disabled).toBe(true)
    expect(view.getVersionExecution).toHaveBeenCalledTimes(readsBeforeRecovery)
    await act(async () => useDesktopRuntimeRecoveryStore.setState({ phase: 'connected' }))
    expect(view.getVersionExecution).toHaveBeenCalledTimes(readsBeforeRecovery + 1)
    expect(view.button('Check readiness').disabled).toBe(false)
    expect(view.button('Check reproducibility')).toBeUndefined()
  } finally {
    await view.cleanup()
  }
})
