import { describe, expect, it } from 'vitest'

import { resolveAgentControlTooltipSide } from './agent-control-tooltip-side'

const horizontalRect = (left: number, right: number): Pick<DOMRect, 'left' | 'right'> => ({
  left,
  right
})

describe('resolveAgentControlTooltipSide', () => {
  it('keeps the preferred side when the session panel has room', () => {
    expect(
      resolveAgentControlTooltipSide('left', horizontalRect(320, 608), horizontalRect(0, 1000))
    ).toBe('left')
  })

  it('flips leaf controls horizontally when only the opposite side fits', () => {
    expect(
      resolveAgentControlTooltipSide('left', horizontalRect(24, 312), horizontalRect(0, 640))
    ).toBe('right')
  })

  it('moves submenu controls above instead of flipping into their expanded submenu', () => {
    expect(
      resolveAgentControlTooltipSide('left', horizontalRect(24, 312), horizontalRect(0, 640), false)
    ).toBe('top')
  })

  it('accounts for the tooltip width, offset, and collision padding', () => {
    expect(
      resolveAgentControlTooltipSide('left', horizontalRect(300, 600), horizontalRect(0, 700))
    ).toBe('top')
  })

  it('moves above the item when a narrow session panel fits neither horizontal side', () => {
    expect(
      resolveAgentControlTooltipSide('left', horizontalRect(24, 312), horizontalRect(0, 360))
    ).toBe('top')
  })
})
