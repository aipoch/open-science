// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NotebookInputFileSummary } from '../../../../shared/notebook'

const upsertAndActivateItem = vi.fn()

vi.mock('@/stores/preview-workbench-store', () => ({
  usePreviewWorkbenchStore: (
    selector: (state: { upsertAndActivateItem: typeof upsertAndActivateItem }) => unknown
  ) => selector({ upsertAndActivateItem })
}))

describe('NotebookInputDataStrip', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    upsertAndActivateItem.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('keeps artifact lineage metadata when opening an Artifact Version input', async () => {
    const { NotebookInputDataStrip } = await import('./NotebookInputDataStrip')
    const input: NotebookInputFileSummary = {
      inputFileVersionId: 'artifact-version-2',
      sourceKind: 'artifact-version',
      sourceFileId: 'artifact-lineage-1',
      sourceVersionNumber: 2,
      sourceProjectId: 'project-1',
      sourceSessionId: 'source-session',
      filename: 'counts.csv',
      contentType: 'text/csv',
      sizeBytes: 42,
      checksum: 'a'.repeat(64),
      association: 'resolver-accessed'
    }

    await act(async () => {
      root.render(<NotebookInputDataStrip inputFiles={[input]} />)
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')?.click()
    })

    expect(upsertAndActivateItem).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'artifact-lineage-1',
        artifactId: 'artifact-lineage-1',
        selectedVersionId: 'artifact-version-2',
        versionNumber: 2
      })
    )
  })

  it('does not render inputs that were available to the turn but never accessed', async () => {
    const { NotebookInputDataStrip } = await import('./NotebookInputDataStrip')
    const input: NotebookInputFileSummary = {
      inputFileVersionId: 'upload-version-1',
      sourceKind: 'upload-version',
      sourceFileId: 'upload-1',
      sourceProjectId: 'project-1',
      sourceSessionId: 'source-session',
      filename: 'unused.csv',
      sizeBytes: 42,
      checksum: 'a'.repeat(64),
      association: 'turn-attached'
    }

    await act(async () => {
      root.render(<NotebookInputDataStrip inputFiles={[input]} />)
    })

    expect(container.querySelector('[data-testid="notebook-input-data"]')).toBeNull()
    expect(container.textContent).not.toContain('unused.csv')
  })

  it('renders a turn attachment whose read was confirmed by file evidence', async () => {
    const { NotebookInputDataStrip } = await import('./NotebookInputDataStrip')
    const input: NotebookInputFileSummary = {
      inputFileVersionId: 'upload-version-1',
      sourceKind: 'upload-version',
      sourceFileId: 'upload-1',
      sourceProjectId: 'project-1',
      sourceSessionId: 'source-session',
      filename: 'used.csv',
      sizeBytes: 42,
      checksum: 'a'.repeat(64),
      association: 'turn-attached',
      accessEvidence: 'file-evidence'
    }

    await act(async () => {
      root.render(<NotebookInputDataStrip inputFiles={[input]} />)
    })

    expect(container.querySelector('[data-testid="notebook-input-data"]')).not.toBeNull()
    expect(container.textContent).toContain('used.csv')
  })
})
