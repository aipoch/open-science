import { describe, expect, it } from 'vitest'

import { previewIdForNotebookInput } from './notebook-input-preview'

describe('Notebook Input preview identity', () => {
  it('reuses the owning Artifact and Upload workbench tab ids across Versions', () => {
    expect(
      previewIdForNotebookInput({
        sourceKind: 'artifact-version',
        sourceFileId: 'artifact-1'
      })
    ).toBe('artifact-1')
    expect(
      previewIdForNotebookInput({ sourceKind: 'upload-version', sourceFileId: 'upload-file-1' })
    ).toBe('upload:upload-file-1')
  })
})
