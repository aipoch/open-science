// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const silk = vi.hoisted(() => vi.fn(() => <canvas data-testid="silk-canvas" />))
vi.mock('./Silk', () => ({ default: silk }))

import { ProviderSilkBackground } from './ProviderSilkBackground'

describe('ProviderSilkBackground', () => {
  it('keeps idle cards static and mounts silk only while hovered', () => {
    const view = render(<ProviderSilkBackground color="#123456" active={false} />)

    expect(silk).not.toHaveBeenCalled()

    view.rerender(<ProviderSilkBackground color="#123456" active />)
    expect(silk).toHaveBeenLastCalledWith(
      expect.objectContaining({
        color: '#123456',
        paused: false,
        rotation: 0,
        speed: 0.35,
        noiseIntensity: 1.6,
        mouseInteraction: false,
        clickRipple: false,
        intro: false,
        wave: 0.45,
        dpr: 1.25,
        glow: 0
      }),
      undefined
    )

    view.rerender(<ProviderSilkBackground color="#123456" active={false} />)
    expect(silk).toHaveBeenCalledTimes(1)
  })
})
