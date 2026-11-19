// @vitest-environment jsdom
import { act, useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import {
  ImageComposerBridgeProvider,
  useImageComposerHost,
  useImageComposerTarget
} from './image-composer-bridge'

function Host({ scope, enabled }: { scope: string; enabled: boolean }): React.JSX.Element {
  const { active, attachHost } = useImageComposerHost(scope, enabled)
  return (
    <>
      <div data-host ref={attachHost} hidden={!active} />
      <textarea data-chat hidden={active} defaultValue="Unsent draft" />
    </>
  )
}
function Editor({ scope, history }: { scope: string; history: boolean }): React.JSX.Element {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null)
  const target = useImageComposerTarget(scope, viewport)
  const input = <textarea data-image defaultValue="Edit instruction" />
  return (
    <div data-editor>
      {history ? null : <div ref={setViewport} />}
      {target ? createPortal(input, target) : input}
    </div>
  )
}
it('scopes the composer, retains it through history, and restores chat on exit or blockers', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = async (
    scope = 'a',
    enabled = true,
    editor = true,
    history = false,
    modal = false
  ): Promise<void> => {
    await act(async () =>
      root.render(
        <ImageComposerBridgeProvider>
          <Host scope={scope} enabled={enabled} />
          {editor && (
            <div role={modal ? 'dialog' : undefined}>
              <Editor scope="a" history={history} />
            </div>
          )}
        </ImageComposerBridgeProvider>
      )
    )
  }
  const inHost = (): boolean => Boolean(container.querySelector('[data-host] [data-image]'))
  const chat = (): HTMLTextAreaElement => container.querySelector('[data-chat]')!
  try {
    await render()
    expect(inHost()).toBe(true)
    expect(chat().hidden).toBe(true)
    await render('a', true, true, true)
    expect(inHost()).toBe(true)
    await render('b')
    expect(inHost()).toBe(false)
    expect(chat().hidden).toBe(false)
    await render('a', false)
    expect(inHost()).toBe(false)
    expect(container.querySelector('[data-editor] [data-image]')).not.toBeNull()
    await render('a', true, false)
    expect(chat().value).toBe('Unsent draft')
    expect(chat().hidden).toBe(false)
    await render('a', true, true, false, true)
    expect(inHost()).toBe(false)
    expect(container.querySelector('[role="dialog"] [data-image]')).not.toBeNull()
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
