// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OnboardingWelcome } from './OnboardingEntry'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const animation = vi.hoisted(() => ({
  load: vi.fn(),
  listeners: new Map<string, () => void>(),
  destroy: vi.fn()
}))

afterEach(() => {
  vi.restoreAllMocks()
  animation.listeners.clear()
  animation.load.mockReset()
  animation.destroy.mockReset()
})

describe('Welcome animation lifecycle', () => {
  it('plays once across parent rerenders and completion, including StrictMode', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      fillRect: vi.fn()
    } as unknown as CanvasRenderingContext2D)
    const { default: lottie } = await import('lottie-web')
    animation.load = vi.spyOn(lottie, 'loadAnimation') as typeof animation.load
    animation.load.mockImplementation(() => ({
      addEventListener: (event: string, listener: () => void) =>
        animation.listeners.set(event, listener),
      removeEventListener: vi.fn(),
      destroy: animation.destroy
    }))
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () =>
        root.render(
          <StrictMode>
            <OnboardingWelcome onNext={() => {}} />
          </StrictMode>
        )
      )
      await waitFor(() => expect(animation.load).toHaveBeenCalledTimes(1))
      expect(animation.load.mock.calls[0][0].loop).toBe(false)
      await act(async () =>
        root.render(
          <StrictMode>
            <OnboardingWelcome onNext={() => {}} />
          </StrictMode>
        )
      )
      expect(animation.load).toHaveBeenCalledTimes(1)
      await act(async () => animation.listeners.get('complete')?.())
      expect(container.querySelector('[data-onboarding-action="next"]')).not.toBeNull()
      expect(animation.load).toHaveBeenCalledTimes(1)
      expect(
        animation.load.mock.calls[0][0].animationData.assets.find(
          (asset: { id: string }) => asset.id === 'center'
        ).p
      ).toContain('logo-symbol.svg')
      expect(
        container.querySelector('.onboarding-entry-brand-mark')?.getAttribute('src')
      ).toContain('logo-symbol.svg')
    } finally {
      act(() => root.unmount())
      container.remove()
    }
    expect(animation.destroy).toHaveBeenCalledTimes(1)
  })

  it('loads a compact animation with external icon assets and reduced keyframes', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      fillRect: vi.fn()
    } as unknown as CanvasRenderingContext2D)
    const { default: lottie } = await import('lottie-web')
    animation.load = vi.spyOn(lottie, 'loadAnimation') as typeof animation.load
    animation.load.mockImplementation(() => ({
      addEventListener: (event: string, listener: () => void) =>
        animation.listeners.set(event, listener),
      removeEventListener: vi.fn(),
      destroy: animation.destroy
    }))
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(<OnboardingWelcome onNext={() => {}} />))
      await waitFor(() => expect(animation.load).toHaveBeenCalledTimes(1))

      const animationData = animation.load.mock.calls[0][0].animationData
      const serialized = JSON.stringify(animationData)
      const providerLayer = animationData.layers.find(
        (layer: { nm: string }) => layer.nm === 'providers: OpenAI'
      )
      const agentLayer = animationData.layers.find(
        (layer: { nm: string }) => layer.nm === 'agents: Codex'
      )

      expect(serialized).not.toContain('data:image/svg+xml;base64')
      expect(Buffer.byteLength(serialized)).toBeLessThan(150_000)
      expect(animationData.fr).toBe(30)
      expect(animationData.op).toBe(90.9)
      expect(
        animationData.assets.find((asset: { id: string }) => asset.id === 'providers-0').p
      ).toMatch(/\.svg(?:\?|$)/)
      expect(providerLayer.ks.p.k.length).toBeLessThan(40)
      expect(agentLayer.ks.p.k.length).toBeLessThan(40)
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })
})
