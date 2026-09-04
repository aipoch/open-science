import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(__dirname, 'main.css'), 'utf8')

type Rgb = [number, number, number]

const themeBlock = (selector: ':root' | '.dark'): string => {
  const escapedSelector = selector.replace('.', '\\.')
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\n\\}`))
  if (!match?.[1]) throw new Error(`Missing ${selector} theme block`)
  return match[1]
}

const hslToken = (block: string, name: string): Rgb => {
  const match = block.match(
    new RegExp(`--${name}:\\s*hsl\\(([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%\\);`)
  )
  if (!match) throw new Error(`Missing HSL token: ${name}`)
  const hue = Number(match[1])
  const saturation = Number(match[2]) / 100
  const lightness = Number(match[3]) / 100
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1))
  const offset = lightness - chroma / 2
  const [red, green, blue] =
    hue < 60
      ? [chroma, second, 0]
      : hue < 120
        ? [second, chroma, 0]
        : hue < 180
          ? [0, chroma, second]
          : hue < 240
            ? [0, second, chroma]
            : hue < 300
              ? [second, 0, chroma]
              : [chroma, 0, second]
  return [red + offset, green + offset, blue + offset]
}

const luminance = ([red, green, blue]: Rgb): number =>
  [red, green, blue]
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0)

const contrast = (left: Rgb, right: Rgb): number => {
  const [lighter, darker] = [luminance(left), luminance(right)].sort(
    (first, second) => second - first
  )
  return (lighter! + 0.05) / (darker! + 0.05)
}

describe('diff color tokens', () => {
  it.each([
    ['light', themeBlock(':root')],
    ['dark', themeBlock('.dark')]
  ])('keeps %s markers and text at WCAG AA contrast', (_theme, block) => {
    const text = hslToken(block, 'text-000')
    for (const kind of ['added', 'removed']) {
      const surface = hslToken(block, `diff-${kind}-surface`)
      const highlight = hslToken(block, `diff-${kind}-highlight`)
      const foreground = hslToken(block, `diff-${kind}-foreground`)

      expect(contrast(foreground, surface)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(text, surface)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(text, highlight)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('limits semantic change markers to their direct list or table carrier', () => {
    for (const kind of ['added', 'removed']) {
      const marker = `[data-managed-diff-marker='${kind}']`
      expect(css).toContain(`:is(li, td, th):has(> ${marker})`)
      expect(css).toContain(`:is(li, td, th):has(> p > ${marker})`)
      expect(css).not.toContain(`:is(li, td, th):has(${marker})`)
    }
  })

  it('marks semantic carrier text without painting the carrier rectangle', () => {
    const semanticRules = css.match(/\.managed-version-diff-markdown[^{}]+\{[^{}]+\}/gu)?.join('\n')

    expect(semanticRules).toBeDefined()
    expect(semanticRules).not.toContain('background-color')
    expect(semanticRules).toContain('color: var(--diff-added-foreground)')
    expect(semanticRules).toContain('color: var(--diff-removed-foreground)')
  })
})
