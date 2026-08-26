// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installStreamdown } from './install-streamdown'

let cleanups: Array<() => void>
let saveBlobFile: ReturnType<typeof vi.fn>

const clickStreamdownBlobDownload = (): void => {
  const root = document.createElement('div')
  root.className = 'agent-markdown-root'
  const button = document.createElement('button')
  button.addEventListener('click', () => {
    const anchor = document.createElement('a')
    anchor.href = URL.createObjectURL(new Blob(['a,b'], { type: 'text/csv' }))
    anchor.download = 'result.csv'
    anchor.addEventListener('click', (event) => event.preventDefault())
    document.body.appendChild(anchor)
    anchor.click()
  })
  root.appendChild(button)
  document.body.appendChild(root)
  button.click()
}

beforeEach(() => {
  saveBlobFile = vi.fn().mockResolvedValue({ saved: true })
  ;(window as unknown as { api: unknown }).api = { saveBlobFile }
  cleanups = []
})

afterEach(() => {
  for (const cleanup of cleanups) cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('Streamdown installation lifecycle', () => {
  it('keeps shared URL hooks until the final caller disposes', () => {
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    const firstCleanup = installStreamdown()
    const secondCleanup = installStreamdown()
    cleanups.push(firstCleanup, secondCleanup)
    const installedCreateObjectURL = URL.createObjectURL
    const installedRevokeObjectURL = URL.revokeObjectURL

    expect(installedCreateObjectURL).not.toBe(originalCreateObjectURL)
    expect(installedRevokeObjectURL).not.toBe(originalRevokeObjectURL)

    firstCleanup()

    expect(URL.createObjectURL).toBe(installedCreateObjectURL)
    expect(URL.revokeObjectURL).toBe(installedRevokeObjectURL)

    secondCleanup()

    expect(URL.createObjectURL).not.toBe(installedCreateObjectURL)
    expect(URL.revokeObjectURL).not.toBe(installedRevokeObjectURL)
  })

  it('keeps the shared bridge installed when one caller disposes more than once', async () => {
    const firstCleanup = installStreamdown()
    const secondCleanup = installStreamdown()
    cleanups.push(firstCleanup, secondCleanup)

    firstCleanup()
    firstCleanup()
    clickStreamdownBlobDownload()
    await new Promise((resolve) => window.setTimeout(resolve, 0))

    expect(saveBlobFile).toHaveBeenCalledOnce()
  })

  it('clears pending image attribution before a later installation', async () => {
    const firstCleanup = installStreamdown()
    cleanups.push(firstCleanup)
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
    firstCleanup()
    cleanups.push(installStreamdown())

    const url = URL.createObjectURL(new Blob(['png'], { type: 'image/png' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'image.png'
    anchor.addEventListener('click', (event) => event.preventDefault())
    document.body.appendChild(anchor)
    anchor.click()
    await new Promise((resolve) => window.setTimeout(resolve, 0))

    expect(saveBlobFile).not.toHaveBeenCalled()
  })
})
