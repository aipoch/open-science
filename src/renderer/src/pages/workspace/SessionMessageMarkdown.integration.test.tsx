// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'

import { SessionMessageMarkdown } from './SessionMessageMarkdown'

describe('SessionMessageMarkdown integration', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('preserves a citation title through the message artifact link renderer', async () => {
    await act(async () => {
      root.render(
        <SessionMessageMarkdown
          content={'The evidence supports this claim.[1](https://example.com/paper "Genome study")'}
          artifacts={[]}
          onPreviewArtifact={vi.fn()}
          onPreviewArtifactModal={vi.fn()}
        />
      )
    })

    const citation = container.querySelector<HTMLAnchorElement>('[data-citation-marker]')
    expect(citation?.getAttribute('aria-label')).toBe('Source 1: Genome study')
  })
})
