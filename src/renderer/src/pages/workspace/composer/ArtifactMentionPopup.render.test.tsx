// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18next } from '@/i18n'
import { ArtifactMentionPopup } from './ArtifactMentionPopup'
import { useNavigationStore } from '@/stores/navigation-store'
import type { ProjectFileItem } from '../../../../../shared/project-files'

let container: HTMLDivElement
let root: Root

const defaultProjectFiles: ProjectFileItem[] = [
  {
    id: 'upload:up-1',
    source: 'upload',
    sourceFileId: 'up-1',
    sourceVersionId: 'up-1-v1',
    projectId: 'default',
    sessionId: 'session-1',
    name: 'sequence.csv',
    path: 'upload-version:default/session-1/up-1-v1',
    mimeType: 'text/csv',
    size: 2048,
    sortAtMs: 1710000001000
  },
  {
    id: 'art-1',
    source: 'artifact',
    sourceFileId: 'art-1',
    sourceVersionId: 'art-1-v1',
    projectId: 'default',
    sessionId: 'session-1',
    name: 'report.pdf',
    path: 'artifact-version:default/session-1/art-1/art-1-v1',
    mimeType: 'application/pdf',
    size: 4096,
    sortAtMs: 1710000002000
  }
]

beforeEach(() => {
  // Non-image rows never read previews, but stub the api so an accidental read never throws.
  ;(window as unknown as { api: unknown }).api = {
    uploads: {
      readPreview: vi.fn().mockResolvedValue({ content: '', encoding: 'base64', size: 0 })
    },
    artifacts: {
      listProjectFiles: vi.fn().mockResolvedValue([]),
      readPreview: vi.fn().mockResolvedValue({ content: '', encoding: 'base64', size: 0 })
    },
    projectFiles: {
      listFiles: vi.fn().mockResolvedValue({
        items: defaultProjectFiles,
        totalCount: defaultProjectFiles.length
      })
    },
    managedFileVersions: {
      inspect: vi.fn().mockImplementation(async (request) => ({
        ok: true,
        value: {
          source: request.source,
          projectId: request.projectId,
          fileId: request.fileId,
          sessionId: 'session-1',
          displayName: request.source === 'upload' ? 'sequence.csv' : 'report.pdf',
          headVersionId: `${request.fileId}-v2`,
          selectedVersionId: `${request.fileId}-v2`,
          versions: [
            {
              id: `${request.fileId}-v2`,
              source: request.source,
              fileId: request.fileId,
              versionNumber: 2,
              displayName: request.source === 'upload' ? 'sequence.csv' : 'report.pdf',
              originKind: request.source === 'upload' ? 'user_upload' : 'agent_generated',
              basedOnVersionId: null,
              contentType: request.source === 'upload' ? 'text/csv' : 'application/pdf',
              sizeBytes: 2048,
              checksum: '2'.repeat(64),
              createdAt: '2026-08-14T00:00:00.000Z'
            }
          ],
          canEdit: false,
          canDiff: false
        }
      }))
    }
  }
  useNavigationStore.setState({ activeProjectId: 'default' })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  void i18next.changeLanguage('en')
})

const options = (): HTMLElement[] =>
  Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'))

const pressKey = (key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init
  })
  act(() => {
    document.dispatchEvent(event)
  })
  return event
}

const flushSelection = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const renderPopup = async ({
  query = '',
  onSelect = vi.fn(),
  onClose = vi.fn()
}: {
  query?: string
  onSelect?: (value: unknown) => void
  onClose?: () => void
} = {}): Promise<void> => {
  await act(async () => {
    root.render(<ArtifactMentionPopup query={query} onSelect={onSelect} onClose={onClose} />)
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('ArtifactMentionPopup', () => {
  it('owns Enter while project files are still loading', () => {
    window.api.projectFiles.listFiles = vi.fn(
      () => new Promise(() => undefined)
    ) as typeof window.api.projectFiles.listFiles
    act(() => {
      root.render(<ArtifactMentionPopup query="seq" onSelect={vi.fn()} onClose={vi.fn()} />)
    })
    const loadingStatus = document.body.querySelector('[role="status"]')
    expect(document.body.querySelector('[role="listbox"]')).not.toBeNull()
    expect(loadingStatus?.textContent).toContain('Loading project files')
    expect(loadingStatus?.getAttribute('aria-live')).toBe('polite')
    expect(loadingStatus?.getAttribute('aria-atomic')).toBe('true')
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true
    })

    act(() => {
      document.dispatchEvent(event)
    })

    expect(event.defaultPrevented).toBe(true)
    expect(pressKey('Tab').defaultPrevented).toBe(false)
  })

  it('renders both sections with rows and tags', async () => {
    await renderPopup()

    expect(window.api.projectFiles.listFiles).toHaveBeenCalledWith({
      projectId: 'default',
      collection: { kind: 'all' },
      limit: 100
    })
    expect(options()).toHaveLength(2)
    const text = document.body.textContent ?? ''
    expect(text).toContain('User uploads')
    expect(text).toContain('Other artifacts')
    expect(text).toContain('sequence.csv')
    expect(text).toContain('report.pdf')
    // Section tags distinguish upload vs generated output.
    expect(text).toContain('upload')
    expect(text).toContain('output')
  })

  it('uses the preview-tab abbreviation for a long filename while preserving its extension', async () => {
    const longName = 'very_long_experiment_analysis_result_2025.csv'
    window.api.projectFiles.listFiles = vi.fn().mockResolvedValue({
      items: [
        {
          ...defaultProjectFiles[1],
          id: 'long-artifact',
          sourceFileId: 'long-artifact',
          sourceVersionId: 'long-artifact',
          name: longName
        }
      ],
      totalCount: 1
    })

    await renderPopup()

    expect(options()[0]?.querySelector('[data-testid="file-name-tail"]')?.textContent).toBe('_2025')
  })

  it('loads every Project Files page before presenting suggestions', async () => {
    window.api.projectFiles.listFiles = vi
      .fn()
      .mockResolvedValueOnce({
        items: [defaultProjectFiles[0]],
        totalCount: 2,
        nextCursor: 'next-page'
      })
      .mockResolvedValueOnce({ items: [defaultProjectFiles[1]], totalCount: 2 })

    await renderPopup()

    expect(options()).toHaveLength(2)
    expect(window.api.projectFiles.listFiles).toHaveBeenNthCalledWith(2, {
      projectId: 'default',
      collection: { kind: 'all' },
      cursor: 'next-page',
      limit: 100
    })
  })

  it('shows a Project Files query failure instead of a false empty state', async () => {
    window.api.projectFiles.listFiles = vi.fn().mockRejectedValue(new Error('database unavailable'))

    await renderPopup()

    expect(options()).toHaveLength(0)
    const alert = document.body.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Could not load project files')
    expect(alert?.getAttribute('aria-live')).toBe('assertive')
    expect(alert?.getAttribute('aria-atomic')).toBe('true')
    expect(document.body.textContent).toContain('Could not load project files')
    expect(document.body.textContent).not.toContain('No artifacts yet')
  })

  it('rejects a repeated Project Files cursor', async () => {
    window.api.projectFiles.listFiles = vi.fn().mockResolvedValue({
      items: [],
      totalCount: 1,
      nextCursor: 'repeated-page'
    })

    await renderPopup()

    expect(window.api.projectFiles.listFiles).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain('Could not load project files')
  })

  it('shows an upload indexed from another session in the same project', async () => {
    const onSelect = vi.fn()
    window.api.projectFiles.listFiles = vi.fn().mockResolvedValue({
      items: [
        {
          id: 'upload:shared-csv',
          source: 'upload',
          sourceFileId: 'shared-csv',
          sourceVersionId: 'shared-csv-v1',
          projectId: 'default',
          sessionId: 'other-session',
          name: 'shared-data.csv',
          path: 'upload-version:default/other-session/shared-csv-v1',
          mimeType: 'text/csv',
          size: 2048,
          sortAtMs: 1710000003000
        }
      ],
      totalCount: 1
    })

    await renderPopup({ onSelect })

    expect(options()).toHaveLength(1)
    expect(document.body.textContent).toContain('shared-data.csv')
    pressKey('Enter')
    await flushSelection()
    expect(onSelect).toHaveBeenCalledWith({
      id: 'upload:shared-csv',
      sourceFileId: 'shared-csv',
      name: 'sequence.csv',
      path: 'upload-version:default/other-session/shared-csv-v1',
      source: 'upload',
      mimeType: 'text/csv',
      versionId: 'shared-csv-v2'
    })
  })

  it('uses the Project Files artifact projection instead of Session metadata', async () => {
    const onSelect = vi.fn()
    window.api.projectFiles.listFiles = vi.fn().mockResolvedValue({
      items: [
        {
          id: 'artifact-lineage-1',
          source: 'artifact',
          sourceFileId: 'artifact-lineage-1',
          sourceVersionId: 'artifact-version-2',
          projectId: 'default',
          sessionId: 'other-session',
          name: 'other-session-result.pdf',
          path: 'artifact-version:default/other-session/artifact-lineage-1/artifact-version-2',
          mimeType: 'application/pdf',
          size: 4096,
          sortAtMs: 1710000004000
        }
      ],
      totalCount: 1
    })

    await renderPopup({ onSelect })

    expect(document.body.textContent).toContain('other-session-result.pdf')
    pressKey('Enter')
    await flushSelection()
    expect(onSelect).toHaveBeenCalledWith({
      id: 'artifact-lineage-1',
      sourceFileId: 'artifact-lineage-1',
      name: 'report.pdf',
      path: 'artifact-version:default/other-session/artifact-lineage-1/artifact-version-2',
      source: 'artifact',
      mimeType: 'application/pdf',
      versionId: 'artifact-lineage-1-v2'
    })
  })

  it('filters rows by a case-insensitive filename query', async () => {
    await renderPopup({ query: 'REPORT' })

    const rendered = options()
    expect(rendered).toHaveLength(1)
    expect(document.body.textContent).toContain('report.pdf')
    expect(document.body.textContent).not.toContain('sequence.csv')
  })

  it('selects the highlighted row on Enter with the picked reference shape', async () => {
    const onSelect = vi.fn()
    await renderPopup({ onSelect })

    // First row is the upload.
    pressKey('Enter')
    await flushSelection()
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'upload:up-1',
        name: 'sequence.csv',
        path: 'upload-version:default/session-1/up-1-v1',
        source: 'upload'
      })
    )
  })

  it('selects the highlighted row on plain Tab but preserves Shift+Tab navigation', async () => {
    const onSelect = vi.fn()
    await renderPopup({ onSelect })

    pressKey('ArrowDown')
    const tabEvent = pressKey('Tab')
    const shiftTabEvent = pressKey('Tab', { shiftKey: true })
    await flushSelection()

    expect(tabEvent.defaultPrevented).toBe(true)
    expect(shiftTabEvent.defaultPrevented).toBe(false)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'art-1' }))
    expect(document.body.textContent).toContain('Enter / Tab select')
  })

  it('selects an artifact row on click', async () => {
    const onSelect = vi.fn()
    await renderPopup({ onSelect })

    const artifactRow = options()[1]
    act(() => artifactRow.click())
    await flushSelection()
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'art-1',
        name: 'report.pdf',
        path: 'artifact-version:default/session-1/art-1/art-1-v1',
        source: 'artifact'
      })
    )
  })

  it('resolves the current DB head when a stale suggestion is selected', async () => {
    const onSelect = vi.fn()
    await renderPopup({ onSelect })

    await act(async () => {
      options()[0]?.click()
      await Promise.resolve()
    })

    expect(window.api.managedFileVersions.inspect).toHaveBeenCalledWith({
      source: 'upload',
      projectId: 'default',
      fileId: 'up-1'
    })
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceFileId: 'up-1',
        versionId: 'up-1-v2',
        name: 'sequence.csv'
      })
    )
  })

  it('keeps the popup open without inserting when head resolution fails', async () => {
    const onSelect = vi.fn()
    window.api.managedFileVersions.inspect = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'VERSION_NOT_FOUND', message: 'File head unavailable.' }
    })
    await renderPopup({ onSelect })
    await act(async () => i18next.changeLanguage('zh-Hans'))

    await act(async () => {
      options()[0]?.click()
      await Promise.resolve()
    })

    expect(onSelect).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('无法解析文件版本。')
    expect(document.body.textContent).not.toContain('File head unavailable.')
    expect(options()).toHaveLength(2)
  })

  it('shows an empty state when the project has no artifacts', async () => {
    window.api.projectFiles.listFiles = vi.fn().mockResolvedValue({ items: [], totalCount: 0 })
    await renderPopup()

    expect(options()).toHaveLength(0)
    expect(document.body.textContent).toContain('No artifacts yet')
  })

  it('closes on Escape', async () => {
    const onClose = vi.fn()
    await renderPopup({ onClose })

    pressKey('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('matches a filename by fuzzy subsequence a substring would miss', async () => {
    await renderPopup({ query: 'rpt' })

    // "rpt" is an ordered subsequence of "report.pdf" but not a substring, and matches no upload.
    const rendered = options()
    expect(rendered).toHaveLength(1)
    expect(rendered[0].textContent).toContain('report.pdf')
    expect(document.body.textContent).not.toContain('sequence.csv')
  })

  it('highlights the matched characters in the filename', async () => {
    await renderPopup({ query: 'report' })

    const marks = Array.from(document.body.querySelectorAll('mark'))
    expect(
      marks
        .map((mark) => mark.textContent)
        .join('')
        .toLowerCase()
    ).toContain('report')
  })

  it('ranks a closer fuzzy match first within a section', async () => {
    // Two outputs in the same section: a prefix match must outrank a later word-boundary match.
    window.api.projectFiles.listFiles = vi.fn().mockResolvedValue({
      items: [
        {
          ...defaultProjectFiles[1],
          id: 'art-late',
          sourceFileId: 'art-late',
          sourceVersionId: 'art-late',
          name: 'final-report.pdf'
        },
        {
          ...defaultProjectFiles[1],
          id: 'art-early',
          sourceFileId: 'art-early',
          sourceVersionId: 'art-early',
          name: 'report.pdf'
        }
      ],
      totalCount: 2
    })

    await renderPopup({ query: 'report' })

    const rendered = options()
    expect(rendered).toHaveLength(2)
    // "report.pdf" (prefix) ranks ahead of "final-report.pdf" (match after the dash).
    expect(rendered[0].textContent).not.toContain('final')
    expect(rendered[1].textContent).toContain('final-report.pdf')
  })
})
