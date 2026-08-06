// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EthernetPort } from 'lucide-react'

import type { EnvironmentCheckItem } from '../../../shared/settings'
import { EnvironmentCheckRow } from './environment-check-row'

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
})
