import { researchFilmResources } from './resources.js'
// @vitest-environment jsdom
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

it('builds button-generated session snapshots without optional sidebar metadata', async () => {
  const workspace = vi.fn(() => ({ el: {}, thread: {}, scroller: {} }))
  const window = {
    OSKit: { workspace },
    Session: undefined as unknown as {
      build: (root: unknown, data: unknown, compact: boolean) => void
    }
  }
  runInNewContext(
    await readFile(join(researchFilmResources().stageDirectory, 'ui/os-session.js'), 'utf8'),
    { window }
  )
  const append = vi.fn()
  window.Session.build(
    { append },
    {
      session: {
        sessionTitle: 'Rainfall',
        messages: [
          { role: 'user', md: 'Question' },
          { role: 'agent', md: 'Measured result' }
        ]
      }
    },
    false
  )
  expect(workspace).toHaveBeenCalledWith(
    expect.objectContaining({
      messages: [
        expect.objectContaining({ i: 0, md: 'Question' }),
        expect.objectContaining({ i: 1, md: 'Measured result' })
      ]
    })
  )
  expect(append).toHaveBeenCalledOnce()
})

it('renders embedded session images and escapes image attributes', async () => {
  const window = {
    VIDEO_ASSETS: { 'files/chart.png': 'data:image/png;base64,AA==' },
    OSKit: undefined as unknown as { markdown: (text: string) => HTMLElement }
  }
  runInNewContext(
    await readFile(join(researchFilmResources().stageDirectory, 'ui/os-kit.js'), 'utf8'),
    {
      window,
      document
    }
  )
  const node = window.OSKit.markdown('![Chart " onerror="alert(1)](files/chart.png)')
  const img = node.querySelector('img')!
  expect(img.getAttribute('src')).toBe(window.VIDEO_ASSETS['files/chart.png'])
  expect(img.getAttribute('alt')).toBe('Chart " onerror="alert(1)')
  expect(img.hasAttribute('onerror')).toBe(false)
  const raw = window.OSKit.markdown('![Local](chart.png" onerror="bad)').querySelector('img')!
  expect(raw.hasAttribute('onerror')).toBe(false)
  expect(window.OSKit.markdown('![Incomplete image').textContent).toBe('![Incomplete image')
})
