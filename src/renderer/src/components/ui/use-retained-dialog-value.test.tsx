// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useRetainedDialogValue } from './use-retained-dialog-value'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const Harness = ({ value }: { value: string | undefined }): React.JSX.Element => {
  const retainedValue = useRetainedDialogValue(value)

  return <div data-testid="retained-value">{retainedValue}</div>
}

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

describe('useRetainedDialogValue', () => {
  it('keeps the last visible payload while the live value is absent', () => {
    act(() => root.render(<Harness value="visible payload" />))
    act(() => root.render(<Harness value={undefined} />))

    expect(container.textContent).toBe('visible payload')
  })

  it('replaces the retained payload when a new value opens', () => {
    act(() => root.render(<Harness value="first payload" />))
    act(() => root.render(<Harness value={undefined} />))
    act(() => root.render(<Harness value="second payload" />))

    expect(container.textContent).toBe('second payload')
  })
})
