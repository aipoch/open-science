// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectFileItem } from '../../../../shared/project-files'
import type { Project } from '../../../../shared/projects'
import { DownloadProjectArtifactsDialog } from './DownloadProjectArtifactsDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const project: Project = {
  id: 'project-1',
  name: 'Research project',
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 1
}

const file = (
  id: string,
  source: ProjectFileItem['source'],
  sessionId: string
): ProjectFileItem => ({
  id,
  source,
  sourceFileId: id,
  sourceVersionId: `${id}-version-1`,
  projectId: project.id,
  sessionId,
  name: `${id}.csv`,
  path: `${source}://${id}`,
  mimeType: 'text/csv',
  size: 1024,
  sortAtMs: 1
})

const files: ProjectFileItem[] = [
  file('report', 'artifact', 'session-1'),
  file('figure', 'artifact', 'session-2'),
  file('dataset', 'upload', 'session-1')
]

let container: HTMLElement
let root: Root
let listFiles: ReturnType<typeof vi.fn>
let saveProjectArtifacts: ReturnType<typeof vi.fn>

beforeEach(() => {
  listFiles = vi.fn().mockResolvedValue({ items: files, totalCount: files.length })
  saveProjectArtifacts = vi.fn().mockResolvedValue({
    saved: true,
    filePath: '/downloads/research.zip'
  })
  ;(window as unknown as { api: unknown }).api = {
    projectFiles: {
      getOverview: vi.fn().mockResolvedValue({
        totalCount: files.length,
        uploadCount: 1,
        artifactCount: 2,
        artifactGroupCount: 2,
        isIndexComplete: true
      }),
      listFiles,
      repairIndex: vi.fn().mockResolvedValue(undefined)
    },
    saveProjectArtifacts
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

const renderDialog = async (
  props?: Partial<React.ComponentProps<typeof DownloadProjectArtifactsDialog>>
): Promise<void> => {
  await act(async () => {
    root.render(<DownloadProjectArtifactsDialog project={project} onClose={vi.fn()} {...props} />)
    await Promise.resolve()
    await Promise.resolve()
  })
}

const confirmButton = (): HTMLButtonElement | null =>
  document.body.querySelector<HTMLButtonElement>(
    '[data-testid="download-project-artifacts-confirm"]'
  )

const checkboxes = (): HTMLInputElement[] => [
  ...document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
]

describe('DownloadProjectArtifactsDialog', () => {
  it('groups every file flat under Generated and Uploads headings without session levels', async () => {
    await renderDialog()

    expect(document.body.textContent).toContain('Download project artifacts')
    expect(document.body.textContent).toContain('3 of 3 selected')
    const dividerClassNames = [...document.body.querySelectorAll<HTMLElement>('div')]
      .map((element) => element.className)
      .filter((className) => className.includes('border-b') || className.includes('border-t'))
    expect(dividerClassNames).toContain(
      'flex shrink-0 items-center justify-between gap-4 border-b border-border-300/90 px-5 py-3.5'
    )
    expect(dividerClassNames).toContain(
      'flex shrink-0 items-center justify-between gap-3 border-t border-border-300/90 px-5 py-3.5'
    )

    const headings = [
      ...document.body.querySelectorAll<HTMLElement>('[data-testid="project-artifacts-group"]')
    ]
    expect(headings.map((heading) => heading.dataset.group)).toEqual(['Generated', 'Uploads'])
    expect(headings[0].getAttribute('role')).toBe('group')
    expect(headings[0].getAttribute('aria-label')).toBe('Generated')
    expect(headings[1].getAttribute('role')).toBe('group')
    expect(headings[1].getAttribute('aria-label')).toBe('Uploads')
    expect(headings[0].textContent).toContain('report.csv')
    expect(headings[0].textContent).toContain('figure.csv')
    expect(headings[0].textContent).not.toContain('dataset.csv')
    expect(headings[1].textContent).toContain('dataset.csv')
    // Rows from different sessions sit side by side: no per-session structure is rendered.
    expect(headings[0].querySelectorAll('input[type="checkbox"]')).toHaveLength(2)
    expect(document.body.textContent).not.toContain('session-1')
    expect(document.body.textContent).not.toContain('session-2')
  })

  it('hides a group heading when that source has no files', async () => {
    listFiles.mockResolvedValue({ items: [files[0]], totalCount: 1 })
    await renderDialog()

    const headings = [
      ...document.body.querySelectorAll<HTMLElement>('[data-testid="project-artifacts-group"]')
    ]
    expect(headings.map((heading) => heading.dataset.group)).toEqual(['Generated'])
    expect(document.body.textContent).not.toContain('Uploads')
  })

  it('selects every file by default and toggles all rows with Check all', async () => {
    await renderDialog()

    expect(checkboxes().every((checkbox) => checkbox.checked)).toBe(true)
    const toggleAll = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent === 'Uncheck all'
    )
    expect(toggleAll).toBeDefined()

    act(() => toggleAll?.click())
    expect(document.body.textContent).toContain('0 of 3 selected')
    expect(checkboxes().every((checkbox) => !checkbox.checked)).toBe(true)
    expect(confirmButton()?.disabled).toBe(true)

    const checkAll = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent === 'Check all'
    )
    act(() => checkAll?.click())
    expect(document.body.textContent).toContain('3 of 3 selected')
    expect(confirmButton()?.disabled).toBe(false)
  })

  it('downloads only the checked subset with source and session metadata', async () => {
    const onClose = vi.fn()
    await renderDialog({ onClose })

    act(() => checkboxes()[1].click())
    expect(document.body.textContent).toContain('2 of 3 selected')

    await act(async () => {
      confirmButton()?.click()
      await Promise.resolve()
    })

    expect(saveProjectArtifacts).toHaveBeenCalledWith({
      projectId: 'project-1',
      suggestedArchiveName: 'Research project',
      files: [
        {
          source: 'artifact',
          sessionId: 'session-1',
          path: 'artifact://report',
          fileId: 'report',
          suggestedName: 'report.csv'
        },
        {
          source: 'upload',
          sessionId: 'session-1',
          path: 'upload://dataset',
          fileId: 'dataset',
          suggestedName: 'dataset.csv'
        }
      ]
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps a legacy file without an authoritative version on the path fallback', async () => {
    const legacyFile = { ...files[0], sourceVersionId: undefined }
    listFiles.mockResolvedValue({ items: [legacyFile], totalCount: 1 })
    await renderDialog()

    await act(async () => {
      confirmButton()?.click()
      await Promise.resolve()
    })

    expect(saveProjectArtifacts).toHaveBeenCalledWith({
      projectId: 'project-1',
      suggestedArchiveName: 'Research project',
      files: [
        {
          source: 'artifact',
          sessionId: 'session-1',
          path: 'artifact://report',
          suggestedName: 'report.csv'
        }
      ]
    })
  })

  it('keeps only failed files selected with an inline summary after a partial export', async () => {
    const onClose = vi.fn()
    // A same-name, same-path file from another session/source must not be mistaken for the
    // failed one: failure matching keys on source + sessionId + path, not path alone.
    const colliding: ProjectFileItem = {
      ...file('figure-copy', 'upload', 'session-9'),
      name: 'figure.csv',
      path: 'artifact://figure'
    }
    listFiles.mockResolvedValue({ items: [...files, colliding], totalCount: 4 })
    saveProjectArtifacts.mockResolvedValue({
      saved: true,
      filePath: '/downloads/research.zip',
      failures: [
        {
          source: 'artifact',
          sessionId: 'session-2',
          path: 'artifact://figure',
          suggestedName: 'figure.csv',
          message: 'disk full'
        }
      ]
    })
    await renderDialog({ onClose })

    await act(async () => {
      confirmButton()?.click()
      await Promise.resolve()
    })

    expect(checkboxes().map((checkbox) => checkbox.checked)).toEqual([false, true, false, false])
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'Downloaded 3 of 4 artifacts. 1 failed.'
    )
    expect(onClose).not.toHaveBeenCalled()
  })

  it('resets selection and error state when reopened for the same project', async () => {
    const onClose = vi.fn()
    saveProjectArtifacts.mockResolvedValue({
      saved: true,
      filePath: '/downloads/research.zip',
      failures: [
        {
          source: 'artifact',
          sessionId: 'session-1',
          path: 'artifact://report',
          suggestedName: 'report.csv',
          message: 'disk full'
        }
      ]
    })
    await renderDialog({ onClose })
    await act(async () => {
      confirmButton()?.click()
      await Promise.resolve()
    })
    expect(document.body.querySelector('[role="alert"]')).not.toBeNull()
    expect(checkboxes().map((checkbox) => checkbox.checked)).toEqual([true, false, false])

    await act(async () => {
      root.render(<DownloadProjectArtifactsDialog project={undefined} onClose={onClose} />)
      await Promise.resolve()
    })
    await act(async () => {
      root.render(<DownloadProjectArtifactsDialog project={project} onClose={onClose} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(listFiles).toHaveBeenCalledTimes(2)
    expect(document.body.querySelector('[role="alert"]')).toBeNull()
    expect(document.body.textContent).toContain('3 of 3 selected')
    expect(checkboxes().every((checkbox) => checkbox.checked)).toBe(true)
  })

  it('refuses to close while a download is in flight', async () => {
    let resolveSave: ((result: unknown) => void) | undefined
    saveProjectArtifacts.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve
        })
    )
    const onClose = vi.fn()
    await renderDialog({ onClose })

    await act(async () => {
      confirmButton()?.click()
      await Promise.resolve()
    })
    expect(saveProjectArtifacts).toHaveBeenCalledTimes(1)

    const closeButton = document.body.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
    expect(closeButton?.disabled).toBe(true)
    act(() => closeButton?.click())
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).not.toHaveBeenCalled()

    // A cancelled save keeps the dialog open and restores normal close behavior.
    await act(async () => {
      resolveSave?.({ saved: false })
      await Promise.resolve()
    })
    expect(onClose).not.toHaveBeenCalled()
    expect(closeButton?.disabled).toBe(false)
    act(() => closeButton?.click())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('offers Retry when the file snapshot cannot be loaded', async () => {
    listFiles
      .mockReset()
      .mockRejectedValueOnce(new Error('file index unavailable'))
      .mockResolvedValueOnce({ items: files, totalCount: files.length })
    await renderDialog()

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
    expect(document.body.textContent).toContain('3 of 3 selected')
  })

  it('shows an inline error when the save flow rejects', async () => {
    const onClose = vi.fn()
    saveProjectArtifacts.mockRejectedValue(new Error('disk full'))
    await renderDialog({ onClose })

    await act(async () => {
      confirmButton()?.click()
      await Promise.resolve()
    })

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('disk full')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows an empty state when the project has no files', async () => {
    listFiles.mockResolvedValue({ items: [], totalCount: 0 })
    await renderDialog()

    expect(document.body.textContent).toContain('No downloadable artifacts in this project.')
    expect(confirmButton()?.disabled).toBe(true)
  })
})
