// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DownloadProgressLine } from './DownloadProgressLine'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('DownloadProgressLine', () => {
  it('shows speed, size, and percent when total is known', () => {
    act(() =>
      root.render(
        <DownloadProgressLine
          progress={{
            phase: 'downloading',
            transferred: 47_400_000,
            total: 335_500_000,
            percent: 14,
            bytesPerSecond: 2_411_724,
            etaSeconds: 130,
            attempt: 0
          }}
        />
      )
    )
    expect(container.textContent).toContain('2.3 MB/s')
    expect(container.textContent).toContain('14%')
  })

  it('shows bytes downloaded without a percent when total is unknown', () => {
    act(() =>
      root.render(
        <DownloadProgressLine
          progress={{
            phase: 'downloading',
            transferred: 47_400_000,
            bytesPerSecond: 2_411_724,
            attempt: 0
          }}
        />
      )
    )
    expect(container.textContent).toContain('downloaded')
    expect(container.textContent).not.toContain('%')
  })

  it('shows a resuming message while reconnecting', () => {
    act(() =>
      root.render(
        <DownloadProgressLine
          progress={{ phase: 'reconnecting', transferred: 1, bytesPerSecond: 0, attempt: 2 }}
        />
      )
    )
    expect(container.textContent).toContain('resuming… (attempt 2)')
  })
})
