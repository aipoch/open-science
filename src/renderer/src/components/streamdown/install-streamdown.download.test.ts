// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installStreamdown } from './install-streamdown'

let uninstall: (() => void) | undefined
let saveBlobFile: ReturnType<typeof vi.fn>

const clickBlobDownload = (url: string, filename = 'result.csv'): void => {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.addEventListener('click', (event) => event.preventDefault())
  document.body.appendChild(anchor)
  anchor.click()
}

const createMermaidDownload = (
  withSvg: boolean
): {
  button: HTMLButtonElement
  diagram: HTMLDivElement
} => {
  const block = document.createElement('div')
  block.dataset.streamdown = 'mermaid-block'
  const actions = document.createElement('div')
  actions.dataset.streamdown = 'mermaid-block-actions'
  const relative = document.createElement('div')
  relative.className = 'relative'
  const button = document.createElement('button')
  const diagram = document.createElement('div')
  diagram.dataset.streamdown = 'mermaid'
  if (withSvg) {
    diagram.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
  }
  relative.appendChild(button)
  actions.appendChild(relative)
  block.append(actions, diagram)
  document.body.appendChild(block)
  return { button, diagram }
}

const clickInlineTableCsvDownload = (): void => {
  const root = document.createElement('div')
  root.className = 'agent-markdown-root'
  root.innerHTML = `
    <div data-streamdown="table-wrapper">
      <div>
        <div class="relative"><button></button></div>
        <div class="relative"><button></button></div>
      </div>
      <table>
        <thead><tr><th>Name</th><th>Value</th></tr></thead>
        <tbody><tr><td>alpha</td><td>1</td></tr></tbody>
      </table>
    </div>
  `
  document.body.appendChild(root)
  const downloadButton = root.querySelectorAll<HTMLButtonElement>('.relative > button').item(1)
  downloadButton.dispatchEvent(
    new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true })
  )

  const csvButton = [
    ...document.querySelectorAll<HTMLButtonElement>('[data-sd-table-format-menu] button')
  ].find((button) => button.textContent === 'CSV')
  if (!csvButton) throw new Error('CSV table format action was not rendered')
  csvButton.dispatchEvent(
    new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true })
  )
}

beforeEach(() => {
  saveBlobFile = vi.fn().mockResolvedValue({ saved: true })
  ;(window as unknown as { api: unknown }).api = { saveBlobFile }
  uninstall = installStreamdown()
})

afterEach(() => {
  uninstall?.()
  uninstall = undefined
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('Streamdown blob download bridge', () => {
  it('saves a blob created synchronously by the current Streamdown button action', async () => {
    const root = document.createElement('div')
    root.className = 'agent-markdown-root'
    const button = document.createElement('button')
    button.addEventListener('click', () => {
      clickBlobDownload(URL.createObjectURL(new Blob(['a,b'], { type: 'text/csv' })))
    })
    root.appendChild(button)
    document.body.appendChild(root)

    button.click()
    await vi.waitFor(() => expect(saveBlobFile).toHaveBeenCalledOnce())
    const request = saveBlobFile.mock.calls[0]?.[0] as {
      suggestedName: string
      mimeType: string
      data: ArrayBuffer
    }
    expect(request).toMatchObject({ suggestedName: 'result.csv', mimeType: 'text/csv' })
    expect(new TextDecoder().decode(request.data)).toBe('a,b')
  })

  it('contains save failures from a tracked blob download', async () => {
    const error = new Error('save failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    saveBlobFile.mockRejectedValueOnce(error)
    const root = document.createElement('div')
    root.className = 'agent-markdown-root'
    const button = document.createElement('button')
    button.addEventListener('click', () => {
      clickBlobDownload(URL.createObjectURL(new Blob(['a,b'], { type: 'text/csv' })))
    })
    root.appendChild(button)
    document.body.appendChild(root)

    button.click()

    await vi.waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith('[streamdown-download] save failed:', error)
    )
  })

  it('does not claim an unrelated blob download after another Streamdown button click', async () => {
    const unrelatedUrl = URL.createObjectURL(new Blob(['pdf'], { type: 'application/pdf' }))
    const root = document.createElement('div')
    root.className = 'agent-markdown-root'
    const button = document.createElement('button')
    root.appendChild(button)
    document.body.appendChild(root)

    button.click()
    clickBlobDownload(unrelatedUrl)
    await new Promise((resolve) => window.setTimeout(resolve, 0))

    expect(saveBlobFile).not.toHaveBeenCalled()
  })

  it('does not save a tracked blob after its object URL is revoked', async () => {
    const root = document.createElement('div')
    root.className = 'agent-markdown-root'
    const button = document.createElement('button')
    button.addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob(['a,b'], { type: 'text/csv' }))
      URL.revokeObjectURL(url)
      clickBlobDownload(url)
    })
    root.appendChild(button)
    document.body.appendChild(root)

    button.click()
    await new Promise((resolve) => window.setTimeout(resolve, 0))

    expect(saveBlobFile).not.toHaveBeenCalled()
  })

  it('saves an image blob created asynchronously by the Streamdown image download action', async () => {
    const root = document.createElement('div')
    root.className = 'agent-markdown-root'
    const imageWrapper = document.createElement('div')
    imageWrapper.dataset.streamdown = 'image-wrapper'
    const button = document.createElement('button')
    imageWrapper.appendChild(button)
    root.appendChild(imageWrapper)
    document.body.appendChild(root)

    button.click()
    await Promise.resolve()
    clickBlobDownload(URL.createObjectURL(new Blob(['png'], { type: 'image/png' })), 'image.png')

    await vi.waitFor(() => expect(saveBlobFile).toHaveBeenCalledOnce())
  })
})

describe('Streamdown Mermaid download bridge', () => {
  it('saves an SVG that appears asynchronously after the download action', async () => {
    const { button, diagram } = createMermaidDownload(false)

    button.click()
    diagram.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))

    await vi.waitFor(() => expect(saveBlobFile).toHaveBeenCalledOnce())
    const request = saveBlobFile.mock.calls[0]?.[0] as {
      suggestedName: string
      mimeType: string
      data: ArrayBuffer
    }
    expect(request).toMatchObject({
      suggestedName: 'diagram.svg',
      mimeType: 'image/svg+xml'
    })
    expect(new TextDecoder().decode(request.data)).toContain('xmlns="http://www.w3.org/2000/svg"')
  })

  it('contains save failures from the Mermaid download action', async () => {
    const error = new Error('save failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    saveBlobFile.mockRejectedValueOnce(error)
    const { button } = createMermaidDownload(true)

    button.click()

    await vi.waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith('[streamdown-download] save failed:', error)
    )
  })
})

describe('Streamdown table download bridge', () => {
  it('saves an inline table as UTF-8 CSV', async () => {
    clickInlineTableCsvDownload()

    await vi.waitFor(() => expect(saveBlobFile).toHaveBeenCalledOnce())
    const request = saveBlobFile.mock.calls[0]?.[0] as {
      suggestedName: string
      mimeType: string
      data: ArrayBuffer
    }
    expect(request).toMatchObject({ suggestedName: 'table.csv', mimeType: 'text/csv' })
    expect([...new Uint8Array(request.data).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  })

  it('contains table save failures and closes the format menu', async () => {
    const error = new Error('save failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    saveBlobFile.mockRejectedValueOnce(error)
    clickInlineTableCsvDownload()

    await vi.waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith('[streamdown-table] action failed:', error)
    )
    expect(document.querySelector('[data-sd-table-format-menu]')).toBeNull()
  })
})
