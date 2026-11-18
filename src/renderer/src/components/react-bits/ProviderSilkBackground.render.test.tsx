// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const silk = vi.hoisted(() => vi.fn(() => <canvas data-testid="silk-canvas" />))
vi.mock('./Silk', () => ({ default: silk }))

import { ProviderSilkBackground } from './ProviderSilkBackground'

describe('ProviderSilkBackground', () => {
  it('keeps a static texture until the card is hovered', () => {
    render(
      <div>
        <ProviderSilkBackground color="#123456" active={false} />
      </div>
    )

    expect(silk).not.toHaveBeenCalled()

    render(<ProviderSilkBackground color="#123456" active />)
    expect(silk).toHaveBeenLastCalledWith(
      expect.objectContaining({
        color: '#123456',
        paused: false,
        rotation: 0,
        speed: 1.15,
        noiseIntensity: 1.6,
        mouseInteraction: false,
        clickRipple: false,
        intro: false,
        wave: 0.45
      }),
      undefined
    )
  })
})
