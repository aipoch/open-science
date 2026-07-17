// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Button } from './button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from './dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger } from './select'
import { Switch } from './switch'
import { Textarea } from './textarea'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = (): void => undefined
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
  document.body.innerHTML = ''
})

describe('shared control interaction styling', () => {
  it('uses the global neutral outline button states and reduced-motion fallback', () => {
    act(() => {
      root.render(
        <Button variant="outline" aria-expanded="true">
          Add skill
        </Button>
      )
    })

    const button = document.body.querySelector<HTMLButtonElement>('[data-slot="button"]')
    expect(button?.className).toContain('border-border')
    expect(button?.className).toContain('bg-card')
    expect(button?.className).toContain('hover:bg-muted')
    expect(button?.className).toContain('aria-expanded:bg-muted')
    expect(button?.className).toContain('motion-reduce:transition-none')
    expect(button?.className).toContain('touch-manipulation')
    expect(button?.className).not.toContain('transition-all')
    expect(button?.className).not.toContain('bg-background')
  })

  it('uses semantic menu surfaces and highlighted item states', async () => {
    await act(async () => {
      root.render(
        <DropdownMenu open>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">Add skill</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Write from scratch</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )
    })

    const trigger = document.body.querySelector<HTMLButtonElement>('[data-slot="button"]')
    const content = document.body.querySelector<HTMLElement>('[data-slot="dropdown-menu-content"]')
    const item = document.body.querySelector<HTMLElement>('[data-slot="dropdown-menu-item"]')

    expect(trigger?.getAttribute('data-state')).toBe('open')
    expect(trigger?.className).toContain('aria-expanded:bg-muted')
    expect(content?.className).toContain('border-border')
    expect(content?.className).toContain('bg-popover')
    expect(content?.className).toContain('text-popover-foreground')
    expect(content?.className).toContain('shadow-menu')
    expect(content?.className).toContain('overscroll-contain')
    expect(item?.className).toContain('rounded-lg')
    expect(item?.className).toContain('data-[highlighted]:bg-muted')
    expect(item?.className).toContain('motion-reduce:transition-none')
  })

  it('matches select triggers and options to the same interaction contract', async () => {
    await act(async () => {
      root.render(
        <Select open value="all">
          <SelectTrigger aria-label="Filter by source">
            <span>All</span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>
      )
    })

    const trigger = document.body.querySelector<HTMLElement>('[data-slot="select-trigger"]')
    const content = document.body.querySelector<HTMLElement>('[data-slot="select-content"]')
    const item = document.body.querySelector<HTMLElement>('[data-slot="select-item"]')

    expect(trigger?.className).toContain('h-8')
    expect(trigger?.className).toContain('rounded-lg')
    expect(trigger?.className).toContain('bg-card')
    expect(trigger?.className).toContain('hover:bg-muted')
    expect(trigger?.className).toContain('data-[state=open]:bg-muted')
    expect(trigger?.className).toContain('focus-visible:ring-3')
    expect(content?.className).toContain('border-border')
    expect(content?.className).toContain('bg-popover')
    expect(content?.className).toContain('shadow-menu')
    expect(content?.className).toContain('overscroll-contain')
    expect(item?.className).toContain('min-h-8')
    expect(item?.className).toContain('rounded-lg')
    expect(item?.className).toContain('data-[highlighted]:bg-muted')
  })

  it('keeps switch and textarea states accessible without mandatory motion', () => {
    act(() => {
      root.render(
        <>
          <Switch aria-label="Disabled setting" disabled />
          <Textarea aria-label="Notes" disabled />
        </>
      )
    })

    const toggle = document.body.querySelector<HTMLButtonElement>('[data-slot="switch"]')
    const thumb = document.body.querySelector<HTMLElement>('[data-slot="switch-thumb"]')
    const textarea = document.body.querySelector<HTMLTextAreaElement>('[data-slot="textarea"]')

    expect(toggle?.disabled).toBe(true)
    expect(toggle?.className).toContain('focus-visible:ring-3')
    expect(toggle?.className).toContain('motion-reduce:transition-none')
    expect(toggle?.className).not.toContain('transition-all')
    expect(thumb?.className).toContain('motion-reduce:transition-none')
    expect(textarea?.disabled).toBe(true)
    expect(textarea?.className).toContain('focus-visible:ring-3')
  })
})
