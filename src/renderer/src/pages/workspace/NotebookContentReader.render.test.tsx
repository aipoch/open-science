// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotebookContentReader } from './NotebookContentReader'
import type { NotebookRunRecord } from '../../../../shared/notebook'

let root: Root
let container: HTMLDivElement
const run = (id: string): NotebookRunRecord => ({
  runId: id,
  cellId: id,
  source: 'user',
  kernelKind: 'python',
  script: '',
  startedAt: 1,
  status: 'completed',
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  workingFiles: [],
  contentRead: { projectId: 'p', sessionId: 's', workspaceCwd: '/w', revision: 'rev' }
})
const response = (data: string, next?: { part: number; offset: number }): unknown => ({
  contentChunk: {
    revision: 'rev',
    cursor: { part: 0, offset: 0 },
    label: 'stdout',
    data,
    partComplete: !next,
    next
  }
})
const click = async (label: string): Promise<void> => {
  await act(async () => {
    const button = [...container.querySelectorAll('button')].find(
      (entry) => entry.textContent === label
    )
    expect(button).toBeDefined()
    button!.click()
  })
}
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { notebook: { state: vi.fn() } }
  })
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('Notebook content window', () => {
  it('reads only on expansion and replaces the previous page instead of accumulating output', async () => {
    vi.mocked(window.api.notebook.state)
      .mockResolvedValueOnce(response('first', { part: 0, offset: 5 }) as never)
      .mockResolvedValueOnce(response('last') as never)
    await act(async () => root.render(<NotebookContentReader run={run('r')} />))
    expect(window.api.notebook.state).not.toHaveBeenCalled()
    await click('Read complete run')
    expect(container.textContent).toContain('first')
    await click('Continue reading')
    expect(container.textContent).toContain('last')
    expect(container.textContent).not.toContain('first')
    await click('Hide output')
    expect(container.querySelector('[data-testid="notebook-content-reader"]')).toBeNull()
  })
  it('isolates a failed read and offers a retry without re-executing code', async () => {
    vi.mocked(window.api.notebook.state)
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({ runs: [run('r')] } as never)
      .mockResolvedValueOnce(response('recovered') as never)
    await act(async () => root.render(<NotebookContentReader run={run('r')} />))
    await click('Read complete run')
    expect(container.textContent).toContain('Could not load Notebook content')
    await click('Retry')
    expect(container.textContent).toContain('recovered')
  })
  it('drops a late page when the reader switches to a different run', async () => {
    let resolve: (value: never) => void = () => {}
    vi.mocked(window.api.notebook.state)
      .mockReturnValueOnce(
        new Promise((done) => {
          resolve = done
        })
      )
      .mockResolvedValueOnce({ runs: [run('new')] } as never)
      .mockResolvedValueOnce(response('new') as never)
    await act(async () => root.render(<NotebookContentReader run={run('old')} />))
    await click('Read complete run')
    await act(async () => root.render(<NotebookContentReader run={run('new')} />))
    await click('Read complete run')
    expect(window.api.notebook.state).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Could not load Notebook content')
    await act(async () => resolve(response('obsolete') as never))
    await click('Retry')
    expect(container.textContent).toContain('new')
    expect(container.textContent).not.toContain('obsolete')
  })
})
