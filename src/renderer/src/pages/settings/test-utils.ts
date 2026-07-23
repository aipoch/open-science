import { act } from 'react'

// Opens a Radix dropdown/select menu in jsdom. Radix triggers open on pointerdown (not click), so
// tests must dispatch the full pointerdown → pointerup → click sequence. Shared by the settings
// render tests instead of repeating the trio inline.
const openRadixMenu = (trigger: HTMLElement | null | undefined): void => {
  act(() => {
    trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    trigger?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
    trigger?.click()
  })
}

// Selects an item inside an open Radix menu (items fire onSelect on pointerdown + click).
const clickRadixMenuItem = (item: HTMLElement | null | undefined): void => {
  act(() => {
    item?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    item?.click()
  })
}

export { clickRadixMenuItem, openRadixMenu }
