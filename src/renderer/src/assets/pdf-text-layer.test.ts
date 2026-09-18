import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(__dirname, 'main.css'), 'utf8')

describe('PDF text layer intrinsic rotation', () => {
  it.each([
    ['90', 'rotate(90deg) translateY(-100%)'],
    ['180', 'rotate(180deg) translate(-100%, -100%)'],
    ['270', 'rotate(270deg) translateX(-100%)']
  ])('maps PDF.js text selection into the %s-degree canvas viewport', (rotation, transform) => {
    expect(css).toContain(`.pdf-text-layer[data-main-rotation='${rotation}']`)
    expect(css).toContain(`transform: ${transform};`)
  })
})
