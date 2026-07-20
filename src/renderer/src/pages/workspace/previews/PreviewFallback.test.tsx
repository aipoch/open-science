// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { PreviewFileItem } from '@/stores/preview-workbench-store'

import { FileWarning } from 'lucide-react'
import { PreviewFallbackCard, PreviewLoadingContent } from './PreviewFallback'
import { PreviewRuntimeBoundary, usePreviewRuntime } from './preview-runtime'

const item: PreviewFileItem = {
  id: 'file-1',
  sessionId: 'session-1',
  title: 'results',
  type: 'file',
  source: 'artifact',
  path: '/artifacts/results',
  name: 'results',
  format: 'spreadsheet'
}

const RetryProbe = (): React.JSX.Element => {
  const runtime = usePreviewRuntime()

  if (runtime?.attempt) return <span data-testid="retry-attempt">{runtime.attempt}</span>

  return (
    <PreviewFallbackCard
      icon={FileWarning}
      name={item.name}
      message="Temporary preview failure"
      retryable
    />
  )
}

describe('PreviewFallback', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('uses the format badge when an extensionless file has a known preview format', async () => {
    await act(async () => {
      root.render(
        <PreviewRuntimeBoundary item={item}>
          <PreviewLoadingContent />
        </PreviewRuntimeBoundary>
      )
    })

    expect(container.querySelector('[data-preview-status="loading"]')?.textContent).toContain(
      'XLSX'
    )
    expect(container.querySelector('[data-preview-status="loading"]')?.textContent).not.toContain(
      'SPREA'
    )
  })

  it('remounts status content on Retry and exposes the incremented attempt', async () => {
    await act(async () => {
      root.render(
        <PreviewRuntimeBoundary item={item}>
          <RetryProbe />
        </PreviewRuntimeBoundary>
      )
    })

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')?.click()
    })

    expect(container.querySelector('[data-testid="retry-attempt"]')?.textContent).toBe('1')
  })
})
