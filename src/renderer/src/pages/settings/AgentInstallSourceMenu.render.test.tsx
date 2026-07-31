// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentInstallSourceMenu } from './AgentInstallSourceMenu'
import { openRadixMenu } from './test-utils'

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

describe('AgentInstallSourceMenu', () => {
  it('shows both guidance and a manual command when a source provides both', () => {
    act(() => {
      root.render(
        <AgentInstallSourceMenu
          name="Cursor Agent"
          label="Install"
          sources={[
            {
              id: 'official-script',
              label: 'Official install script',
              description: 'Install it yourself, sign in, then detect it.',
              displayCommand: 'curl https://cursor.com/install -fsS | bash',
              requiresNpm: false
            }
          ]}
          installing={false}
          disabled={false}
          npmAvailable
          blockedInstallSources={{}}
          onInstall={vi.fn()}
        />
      )
    })

    openRadixMenu(container.querySelector<HTMLElement>('[aria-label="Install Cursor Agent"]'))

    expect(document.body.textContent).toContain('Install it yourself, sign in, then detect it.')
    expect(document.body.textContent).toContain('curl https://cursor.com/install -fsS | bash')
  })
})
