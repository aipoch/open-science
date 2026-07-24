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
