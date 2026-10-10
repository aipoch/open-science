// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { OverlayPortalContainer } from './overlay-portal-container'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import { Select, SelectContent, SelectItem, SelectTrigger } from './select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip'

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = (): void => undefined

const surfaces = {
  popover: (
    <Popover open>
      <PopoverTrigger>Information</PopoverTrigger>
      <PopoverContent data-testid="surface">Saved information</PopoverContent>
    </Popover>
  ),
  select: (
    <Select open defaultValue="a">
      <SelectTrigger aria-label="Speed" />
      <SelectContent data-testid="surface">
        <SelectItem value="a">Normal speed</SelectItem>
      </SelectContent>
    </Select>
  ),
  tooltip: (
    <TooltipProvider>
      <Tooltip open>
        <TooltipTrigger>Help</TooltipTrigger>
        <TooltipContent data-testid="surface">Saved help</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
afterEach(cleanup)

describe.each(Object.entries(surfaces))('%s portal scope', (_name, surface) => {
  it('defaults to the document body', () => {
    const host = document.createElement('div')
    document.body.append(host)
    render(surface, { container: host })
    expect(document.body.contains(screen.getByTestId('surface'))).toBe(true)
    expect(host.contains(screen.getByTestId('surface'))).toBe(false)
  })

  it('keeps a scoped fullscreen control within the supplied root', () => {
    const root = document.createElement('div')
    document.body.append(root)
    render(
      <OverlayPortalContainer.Provider value={root}>{surface}</OverlayPortalContainer.Provider>,
      { container: root }
    )
    expect(root.contains(screen.getByTestId('surface'))).toBe(true)
  })
})
