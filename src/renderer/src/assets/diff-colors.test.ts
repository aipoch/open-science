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

// These are the actual shared substrates, including the strongest hover surface. A token used
// for small metadata must stay readable wherever the existing surface ramp is used.
describe('shared text and ANSI contrast', () => {
  it.each(['light', 'dark'] as const)(
    'keeps %s text and filled-danger labels readable',
    (theme) => {
      const block = themeBlock(theme === 'light' ? ':root' : '.dark')
      for (const name of ['text-100', 'text-200', 'text-300', 'muted-foreground', 'success-000']) {
        const foreground = hslToken(
          block,
          name === 'text-100' && theme === 'light' ? 'muted-foreground' : name
        )
        for (const surface of ['bg-000', 'bg-10', 'bg-200', 'bg-300', 'bg-400']) {
          expect(
            contrast(foreground, hslToken(block, surface)),
            `${name} on ${surface}`
          ).toBeGreaterThanOrEqual(4.5)
        }
      }
      const danger = hslToken(block, 'danger-000')
      const label = hslToken(block, 'danger-foreground')
      const substrate = hslToken(block, 'bg-000')
      const hovered = danger.map((channel, index) => channel * 0.9 + substrate[index]! * 0.1) as Rgb
      expect(contrast(label, danger)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(label, hovered)).toBeGreaterThanOrEqual(4.5)
    }
  )

  it.each(['light', 'dark'] as const)(
    'keeps %s ANSI colors readable, including faint and paired backgrounds',
    (theme) => {
      const block = themeBlock(':root').replace(
        /light-dark\((hsl\([^)]*\)),\s*(hsl\([^)]*\))\)/gu,
        (_match, light: string, dark: string) => (theme === 'light' ? light : dark)
      )
      const parent = hslToken(themeBlock(theme === 'light' ? ':root' : '.dark'), 'bg-200')
      const backgrounds = [
        parent,
        ...[40, 41, 42, 43, 44, 45, 46, 47, 100, 101, 102, 103, 104, 105, 106, 107].map((code) =>
          hslToken(block, `notebook-ansi-bg-${code}`)
        )
      ]
      for (const code of [30, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97]) {
        const foreground = hslToken(block, `notebook-ansi-${code}`)
        for (const background of backgrounds) {
          for (const opacity of [1, 0.9]) {
            const faded = (color: Rgb): Rgb =>
              color.map(
                (channel, index) => channel * opacity + parent[index]! * (1 - opacity)
              ) as Rgb
            expect(
              contrast(faded(foreground), faded(background)),
              `SGR ${code}, opacity ${opacity}`
            ).toBeGreaterThanOrEqual(4.5)
          }
        }
      }
    }
  )
})
