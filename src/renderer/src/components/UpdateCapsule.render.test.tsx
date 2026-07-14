// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useUpdateStore } from '@/stores/update-store'
import { UpdateCapsule } from './UpdateCapsule'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  useUpdateStore.setState({
    appInfo: null,
    status: { state: 'up-to-date', current: '0.2.0', latest: '0.2.0' }
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('UpdateCapsule', () => {
  it('renders nothing when there is no update', () => {
    act(() => {
      root.render(<UpdateCapsule />)
    })

    expect(container.textContent).toBe('')
    expect(container.children.length).toBe(0)
  })

  it('renders the update capsule when a new version is available', () => {
    useUpdateStore.setState({
      status: { state: 'available', current: '0.2.0', latest: '0.3.0', notes: 'n' }
    })

    act(() => {
      root.render(<UpdateCapsule />)
    })

    const button = container.querySelector('button[aria-label="Update available: 0.3.0"]')
    expect(button).not.toBeNull()
  })
})
