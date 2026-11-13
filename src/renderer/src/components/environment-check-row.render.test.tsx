// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EthernetPort } from 'lucide-react'

import type { EnvironmentCheckItem } from '../../../shared/settings'
import { i18next } from '@/i18n'
import { EnvironmentCheckRow } from './environment-check-row'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  act(() => root.unmount())
  container.remove()
  await i18next.changeLanguage('en')
})

const check: EnvironmentCheckItem = {
  id: 'install-network',
  label: 'Internet connection',
  status: 'passed',
  summary: 'The internet is reachable.'
}

describe('EnvironmentCheckRow', () => {
  it('uses the id-derived icon by default', async () => {
    await act(async () => {
      root.render(
        <ul>
          <EnvironmentCheckRow check={check} />
        </ul>
      )
    })

    expect(container.querySelector('svg.lucide-wifi')).not.toBeNull()
  })

  it('honours the icon override', async () => {
    await act(async () => {
      root.render(
        <ul>
          <EnvironmentCheckRow check={check} icon={EthernetPort} />
        </ul>
      )
    })

    expect(container.querySelector('svg.lucide-ethernet-port')).not.toBeNull()
    expect(container.querySelector('svg.lucide-wifi')).toBeNull()
  })

  it('uses the audit translation for warning status', async () => {
    await act(async () => i18next.changeLanguage('zh-Hans'))
    await act(async () => {
      root.render(
        <ul>
          <EnvironmentCheckRow check={{ ...check, status: 'warning' }} />
        </ul>
      )
    })

    expect(container.textContent).toContain('审核')
    expect(container.textContent).not.toContain('综述')
  })
})
