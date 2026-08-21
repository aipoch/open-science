// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectFileItem } from '../../../../shared/project-files'
import type { ChatSession } from '@/stores/session-store'
import { DownloadSessionArtifactsDialog } from './DownloadSessionArtifactsDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session: ChatSession = {
  id: 'session-1',
  projectId: 'project-1',
  title: 'Analysis session',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  createdAt: 1710000000000,
  updatedAt: 1710000000000
}

const artifacts: ProjectFileItem[] = [
  {
    id: 'artifact-1',
    source: 'artifact',
    sourceFileId: 'artifact-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    name: 'report.csv',
    path: 'artifact://report',
    mimeType: 'text/csv',
    size: 1536,
    sortAtMs: 2
  },
  {
    id: 'artifact-2',
    source: 'artifact',
    sourceFileId: 'artifact-2',
    projectId: 'project-1',
    sessionId: 'session-1',
    name: 'figure.png',
    path: 'artifact://figure',
    mimeType: 'image/png',
    size: 4096,
    sortAtMs: 1
  }
]

let container: HTMLElement
let root: Root
let listFiles: ReturnType<typeof vi.fn>
let saveSessionArtifacts: ReturnType<typeof vi.fn>

beforeEach(() => {
  listFiles = vi.fn().mockResolvedValue({ items: artifacts, totalCount: artifacts.length })
  saveSessionArtifacts = vi.fn().mockResolvedValue({
    saved: true,
    filePaths: ['/downloads/report.csv']
  })
  ;(window as unknown as { api: unknown }).api = {
    projectFiles: {
      getOverview: vi.fn().mockResolvedValue({
        totalCount: artifacts.length,
        uploadCount: 0,
        artifactCount: artifacts.length,
        artifactGroupCount: 1,
        isIndexComplete: true
      }),
      listFiles,
      repairIndex: vi.fn().mockResolvedValue(undefined)
    },
    saveSessionArtifacts
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('DownloadSessionArtifactsDialog', () => {
  it('selects every Artifact by default and downloads only the checked rows', async () => {
    const onClose = vi.fn()
    await act(async () => {
      root.render(<DownloadSessionArtifactsDialog session={session} onClose={onClose} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Download session artifacts')
    expect(document.body.textContent).toContain('2 of 2 selected')
    const dividerClassNames = [...document.body.querySelectorAll<HTMLElement>('div')]
      .map((element) => element.className)
      .filter((className) => className.includes('border-b') || className.includes('border-t'))
    expect(dividerClassNames).toContain(
      'flex shrink-0 items-center justify-between gap-4 border-b border-border-300/90 px-5 py-3.5'
    )
    expect(dividerClassNames).toContain(
      'flex shrink-0 items-center justify-between gap-3 border-t border-border-300/90 px-5 py-3.5'
    )
    expect(document.body.textContent).toContain('report.csv')
    expect(document.body.textContent).toContain('figure.png')
    const checkboxes = [
      ...document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    ]
    expect(checkboxes).toHaveLength(2)
    expect(checkboxes.every((checkbox) => checkbox.checked)).toBe(true)

    act(() => checkboxes[1].click())
    expect(document.body.textContent).toContain('1 of 2 selected')

    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-testid="download-session-artifacts-confirm"]')
        ?.click()
      await Promise.resolve()
    })

    expect(saveSessionArtifacts).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      files: [{ path: 'artifact://report', fileId: 'artifact-1', suggestedName: 'report.csv' }]
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('preserves the selection when the same Session receives a live metadata update', async () => {
    await act(async () => {
      root.render(<DownloadSessionArtifactsDialog session={session} onClose={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    const checkboxes = [
      ...document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    ]
    act(() => checkboxes[1].click())
    expect(document.body.textContent).toContain('1 of 2 selected')

    await act(async () => {
      root.render(
        <DownloadSessionArtifactsDialog
          session={{ ...session, title: 'Analysis session updated', status: 'running' }}
          onClose={vi.fn()}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(listFiles).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('1 of 2 selected')
  })

  it('offers Retry when the Artifact snapshot cannot be loaded', async () => {
    listFiles
      .mockReset()
      .mockRejectedValueOnce(new Error('file index unavailable'))
      .mockResolvedValueOnce({ items: artifacts, totalCount: artifacts.length })
    await act(async () => {
      root.render(<DownloadSessionArtifactsDialog session={session} onClose={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'file index unavailable'
    )

    await act(async () => {
      const retry = [...document.body.querySelectorAll('button')].find(
        (button) => button.textContent === 'Retry'
      )
      retry?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(listFiles).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain('report.csv')
    expect(document.body.textContent).toContain('2 of 2 selected')
  })

  it('keeps only failed Artifacts selected after a partial batch export', async () => {
    const onClose = vi.fn()
    saveSessionArtifacts.mockResolvedValue({
      saved: true,
      filePaths: ['/downloads/report.csv'],
      failures: [{ path: 'artifact://figure', suggestedName: 'figure.png', message: 'disk full' }]
    })
    await act(async () => {
      root.render(<DownloadSessionArtifactsDialog session={session} onClose={onClose} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-testid="download-session-artifacts-confirm"]')
        ?.click()
      await Promise.resolve()
    })

    const checkboxes = [
      ...document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    ]
    expect(checkboxes.map((checkbox) => checkbox.checked)).toEqual([false, true])
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'Downloaded 1 of 2 artifacts. 1 failed.'
    )
    expect(onClose).not.toHaveBeenCalled()
  })
})
