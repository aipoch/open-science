// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { ChatSession } from '@/stores/session-store'
import type {
  SessionReproducibilityBatch,
  SessionReproducibilityCommand
} from '../../../../shared/session-reproducibility'
import { SessionReproducibilityDialog } from './SessionReproducibilityDialog'

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
