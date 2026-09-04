// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentControlMenuItemTooltip } from './AgentControlMenuItemTooltip'

import { TooltipProvider } from '@/components/ui/tooltip'

describe('AgentControlMenuItemTooltip', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  const renderDisabledTooltip = (): {
    container: HTMLElement
    trigger: HTMLElement
    description: string
  } => {
    const description = 'Memory is unavailable.'
    const { container, getByRole } = render(
      <TooltipProvider delayDuration={0}>
        <AgentControlMenuItemTooltip description={description}>
          <button type="button" aria-disabled="true">
            Memory
          </button>
        </AgentControlMenuItemTooltip>
      </TooltipProvider>
    )
    const trigger = getByRole('button', { name: 'Memory' })

    return { container, trigger, description }
  }

  it('opens for keyboard focus on an aria-disabled trigger', async () => {
    const { container, trigger, description } = renderDisabledTooltip()
    const nativeMatches = trigger.matches.bind(trigger)
    vi.spyOn(trigger, 'matches').mockImplementation(
      (selector) => selector === ':focus-visible' || nativeMatches(selector)
    )

    fireEvent.focus(trigger)
    await waitFor(() =>
      expect(
        container.ownerDocument.querySelector('[data-slot="tooltip-content"]')?.textContent
      ).toContain(description)
    )
  })

  it('opens for pointer hover on an aria-disabled trigger', async () => {
    const { container, trigger, description } = renderDisabledTooltip()
    fireEvent.pointerMove(trigger, { pointerType: 'mouse' })
    await waitFor(() =>
      expect(
        container.ownerDocument.querySelector('[data-slot="tooltip-content"]')?.textContent
      ).toContain(description)
    )
  })
})
