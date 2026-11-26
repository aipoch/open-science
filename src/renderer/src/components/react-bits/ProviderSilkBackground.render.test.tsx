// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./Silk', () => ({
  default: ({ paused }: { paused: boolean }) => <canvas data-paused={paused} />
}))

import { ProviderSilkBackground } from './ProviderSilkBackground'

describe('ProviderSilkBackground', () => {
  it('pauses and resumes the same Silk canvas', () => {
    const view = render(<ProviderSilkBackground color="#123456" active={false} />)
    const canvas = view.container.querySelector('canvas')!
    expect(canvas.dataset.paused).toBe('true')
    view.rerender(<ProviderSilkBackground color="#123456" active />)
    expect(canvas.dataset.paused).toBe('false')
    view.rerender(<ProviderSilkBackground color="#123456" active={false} />)
    expect(canvas.dataset.paused).toBe('true')
    expect(view.container.querySelector('canvas')).toBe(canvas)
  })
})
