// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  ResearchRunInspection,
  ResearchRunPlan
} from '../../../../shared/research-run-launcher'
import { createI18nTestStub } from '../../../../../test/i18n-test-stub'
import {
  ResearchRunLauncher,
  ResearchRunStatus,
  type ResearchRunLauncherProps
} from './ResearchRunLauncher'

vi.mock('react-i18next', () => createI18nTestStub())
const originalApi = window.api
const inspect = vi.fn()
const source = {
  sourceProjectId: 'project',
  sourceSessionId: 'source',
  sourceImportId: 'import',
  sourceTitle: 'Research'
}
const plan: ResearchRunPlan = {
  key: 'engineering',
  title: 'Offline engineering',
  scope: 'engineering-check',
  claim: 'Execute the bounded offline validation.',
  limitations: ['Does not reproduce private scientific inputs.'],
  materialKeys: ['source'],
  materials: [{ key: 'source', status: 'available', versionIds: ['source-version'] }],
  materialReady: true,
  compatibleRuntimeIds: ['node'],
  entrypoints: [{ materialKey: 'source', path: 'run.mjs' }],
  requiresSecrets: false,
  requirements: { node: '22', platforms: ['darwin'] }
}
const ready: ResearchRunInspection = {
  source: {
    projectId: 'project',
    sessionId: 'source',
    importId: 'import',
    title: 'Research',
    identity: 'frozen-source'
  },
  status: 'ready',
  descriptorCandidates: [
    {
      versionId: 'description',
      filename: 'reproduction.json',
      sha256: 'a'.repeat(64),
      sizeBytes: 2
    }
  ],
  descriptor: {
    versionId: 'description',
    filename: 'reproduction.json',
    sha256: 'a'.repeat(64),
    sizeBytes: 2
  },
  plans: [plan],
  runtimes: [
    { runtimeId: 'node', kind: 'node', version: '22.12.0', platform: 'darwin', arch: 'arm64' }
  ],
  diagnostics: { nativeServiceSupported: true, issues: [] }
}
const props = (extra: Partial<ResearchRunLauncherProps> = {}): ResearchRunLauncherProps => ({
  source,
  destination: { kind: 'new-discussion' },
  onStart: vi.fn().mockResolvedValue(undefined),
  ...extra
})
const open = async (): Promise<void> => {
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Run…' })))
}
const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
beforeEach(() => {
  inspect.mockReset().mockResolvedValue(structuredClone(ready))
  window.api = { ...originalApi, researchRuns: { inspect } } as never
})
afterEach(() => {
  cleanup()
  window.api = originalApi
  vi.restoreAllMocks()
})

it('inspects without creating a discussion and explains the actual engineering scope', async () => {
  const onStart = vi.fn()
  render(<ResearchRunLauncher {...props({ onStart })} />)
  expect(inspect).not.toHaveBeenCalled()
  await open()
  expect(inspect).toHaveBeenCalledExactlyOnceWith({
    projectId: 'project',
    sourceSessionId: 'source',
    sourceImportId: 'import'
  })
  expect(onStart).not.toHaveBeenCalled()
  expect(screen.getByText('Results will be saved in a new discussion.')).toBeTruthy()
  expect(screen.getByText('Engineering validation')).toBeTruthy()
  expect(screen.getByText(plan.claim)).toBeTruthy()
  expect(screen.getByText(plan.limitations[0])).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Start run' }).hasAttribute('disabled')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(onStart).not.toHaveBeenCalled()
})

it('keeps a source inspectable when the current Agent cannot start', async () => {
  render(
    <ResearchRunLauncher
      {...props({
        blockedReason: 'Choose a model first.',
        destination: { kind: 'current-discussion', title: 'A discussion' }
      })}
    />
  )
  await open()
  expect(screen.getByText('Results will be saved in “A discussion”.')).toBeTruthy()
  expect(screen.getByText('Choose a model first.')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Start run' }).hasAttribute('disabled')).toBe(true)
})

it.each(['no-description', 'unsupported', 'invalid'] as const)(
  'does not offer execution for %s',
  async (status) => {
    inspect.mockResolvedValue({ ...ready, status, plans: [], descriptor: undefined })
    render(<ResearchRunLauncher {...props()} />)
    await open()
    expect(screen.getByRole('button', { name: 'Start run' }).hasAttribute('disabled')).toBe(true)
  }
)

it('requires an explicit choice between descriptions and preserves the inspected source identity', async () => {
  const other = {
    ...ready.descriptor!,
    versionId: 'other-description',
    filename: 'alternative.json'
  }
  inspect
    .mockResolvedValueOnce({
      ...ready,
      status: 'choose-description',
      plans: [],
      descriptor: undefined,
      descriptorCandidates: [ready.descriptor, other]
    })
    .mockResolvedValueOnce(ready)
  render(<ResearchRunLauncher {...props()} />)
  await open()
  expect(screen.getByRole('button', { name: 'Start run' }).hasAttribute('disabled')).toBe(true)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'alternative.json' })))
  expect(inspect).toHaveBeenLastCalledWith({
    projectId: 'project',
    sourceSessionId: 'source',
    sourceImportId: 'import',
    descriptorVersionId: 'other-description',
    expectedSourceIdentity: 'frozen-source'
  })
})

it('requires choosing a plan and blocks unavailable materials without hiding alternatives', async () => {
  const blocked = {
    ...plan,
    key: 'private',
    title: 'Private full experiment',
    materialReady: false,
    materials: [{ key: 'private-data', status: 'withheld' }]
  }
  inspect.mockResolvedValue({ ...ready, plans: [blocked, plan] })
  render(<ResearchRunLauncher {...props()} />)
  await open()
  expect(screen.getByRole('button', { name: 'Start run' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('radio', { name: 'Private full experiment' }))
  expect(screen.getByText('Not shared by the author')).toBeTruthy()
  expect(
    screen.getByText(
      'Required materials are unavailable. Choose another plan or supply the missing materials.'
    )
  ).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Start run' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('radio', { name: plan.title }))
  expect(screen.getByRole('button', { name: 'Start run' }).hasAttribute('disabled')).toBe(false)
})

it('submits the reviewed selection once, waits for admission, and disables dismissal meanwhile', async () => {
  const pending = deferred<void>()
  const onStart = vi.fn(() => pending.promise)
  render(<ResearchRunLauncher {...props({ onStart })} />)
  await open()
  const start = screen.getByRole('button', { name: 'Start run' })
  fireEvent.click(start)
  fireEvent.click(start)
  expect(onStart).toHaveBeenCalledExactlyOnceWith({ inspection: ready, plan })
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true)
  await act(async () => pending.resolve())
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('keeps failed starts reviewable and allows retry', async () => {
  const onStart = vi
    .fn()
    .mockRejectedValueOnce(new Error('The source changed. Inspect again.'))
    .mockResolvedValue(undefined)
  render(<ResearchRunLauncher {...props({ onStart })} />)
  await open()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start run' })))
  expect(screen.getByText('The source changed. Inspect again.')).toBeTruthy()
  expect(screen.getByRole('dialog')).toBeTruthy()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start run' })))
  expect(onStart).toHaveBeenCalledTimes(2)
})

it('retries a failed read without sending or opening any discussion', async () => {
  inspect.mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValueOnce(ready)
  const onStart = vi.fn()
  render(<ResearchRunLauncher {...props({ onStart })} />)
  await open()
  expect(screen.getByText('Could not inspect this research. Please retry.')).toBeTruthy()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })))
  expect(screen.getByRole('radio', { name: plan.title })).toBeTruthy()
  expect(onStart).not.toHaveBeenCalled()
})

it('discards a closed inspection when a later opening finishes first', async () => {
  const stale = deferred<ResearchRunInspection>()
  inspect.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(ready)
  render(<ResearchRunLauncher {...props()} />)
  await open()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await open()
  await act(async () => stale.resolve({ ...ready, status: 'invalid', plans: [] }))
  expect(screen.getByRole('radio', { name: plan.title })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Start run' }).hasAttribute('disabled')).toBe(false)
})

it('closes and invalidates inspection when the research source changes', async () => {
  const stale = deferred<ResearchRunInspection>()
  inspect.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(ready)
  const view = render(<ResearchRunLauncher {...props()} />)
  await open()
  view.rerender(
    <ResearchRunLauncher {...props({ source: { ...source, sourceSessionId: 'another' } })} />
  )
  await act(async () => stale.resolve(ready))
  expect(screen.queryByRole('dialog')).toBeNull()
  await open()
  expect(inspect).toHaveBeenLastCalledWith({
    projectId: 'project',
    sourceSessionId: 'another',
    sourceImportId: 'import'
  })
})

it.each([
  {
    patch: { compatibleRuntimeIds: [] },
    message: 'No compatible managed Node.js runtime is ready for this plan.'
  },
  {
    patch: { entrypoints: [] },
    message: 'This plan has no startup instructions. Ask the Agent to prepare them.'
  },
  {
    patch: { requiresSecrets: true },
    message: 'Automatic credential setup is not supported for this plan. Ask the Agent for help.'
  }
])('blocks unsupported setup: $message', async ({ patch, message }) => {
  inspect.mockResolvedValue({ ...ready, plans: [{ ...plan, ...patch }] })
  render(<ResearchRunLauncher {...props()} />)
  await open()
  expect(screen.getByText(message)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Start run' }).hasAttribute('disabled')).toBe(true)
})

it('keeps headless execution available when interactive pages are unsupported', async () => {
  inspect.mockResolvedValue({
    ...ready,
    diagnostics: { nativeServiceSupported: false, issues: [] }
  })
  render(<ResearchRunLauncher {...props()} />)
  await open()
  expect(
    screen.getByText(
      'Interactive project pages are unavailable on this device. Logs and results remain available.'
    )
  ).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Start run' }).hasAttribute('disabled')).toBe(false)
})

it('opens an existing run without offering to start again and can retry an unavailable status', () => {
  const onOpen = vi.fn()
  const onRetry = vi.fn()
  const view = render(<ResearchRunStatus stage="running" onOpen={onOpen} onRetry={onRetry} />)
  expect(screen.getByRole('status').textContent).toBe('Run in progress')
  expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Start run' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'View run' }))
  expect(onOpen).toHaveBeenCalledOnce()
  view.rerender(<ResearchRunStatus stage="unavailable" onRetry={onRetry} />)
  expect(screen.queryByRole('button', { name: 'View run' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  expect(onRetry).toHaveBeenCalledOnce()
})
