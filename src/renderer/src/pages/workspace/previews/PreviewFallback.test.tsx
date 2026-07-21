// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { PreviewFileItem } from '@/stores/preview-workbench-store'

import { FileWarning } from 'lucide-react'
import { PreviewFallbackCard, PreviewLoadingContent } from './PreviewFallback'
import { PreviewRuntimeBoundary } from './preview-runtime'
import { usePreviewRuntime } from './preview-runtime-context'

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

  it('keeps the shared loading chrome while phase copy changes', async () => {
    const renderLoading = (title: string, description: string): React.JSX.Element => (
      <PreviewRuntimeBoundary item={item}>
        <PreviewLoadingContent title={title} description={description} />
      </PreviewRuntimeBoundary>
    )

    await act(async () => {
      root.render(renderLoading('Preparing spreadsheet', item.name))
    })

    const initialStatus = container.querySelector('[data-preview-status="loading"]')
    expect(initialStatus?.textContent).toContain('Preparing spreadsheet')
    expect(initialStatus?.textContent).toContain(item.name)
    expect(container.querySelectorAll('[data-preview-activity-dot]')).toHaveLength(3)
    expect(container.querySelectorAll('[data-preview-progress]')).toHaveLength(1)

    await act(async () => {
      root.render(
        renderLoading(
          'Parsing the Excel workbook',
          'Preparing worksheets, styles, and virtualized viewport data.'
        )
      )
    })

    const parsingStatus = container.querySelector('[data-preview-status="loading"]')
    expect(parsingStatus).toBe(initialStatus)
    expect(parsingStatus?.textContent).toContain('Parsing the Excel workbook')
    expect(parsingStatus?.textContent).not.toContain('Please wait')
    expect(parsingStatus?.textContent).toContain(
      'Preparing worksheets, styles, and virtualized viewport data.'
    )
    expect(container.querySelectorAll('[data-preview-activity-dot]')).toHaveLength(3)
    expect(container.querySelectorAll('[data-preview-progress]')).toHaveLength(1)
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
