import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { nativeCaptionOwnedInlineFragments } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-caption-script-order.mjs')).href
)

it('retains a raised radical and both numeric superscripts in an owned caption row', () => {
  const page = {
    lines: [
      { text: 'Y = r sin(ωt), r =', x: 50, y: 100, width: 100, height: 10, fontSize: 10 },
      { text: '√', x: 153, y: 92, width: 7, height: 10, fontSize: 10 },
      { text: 'X', x: 160, y: 100, width: 10, height: 10, fontSize: 10 },
      { text: '2', x: 170, y: 96, width: 5, height: 7, fontSize: 7 },
      { text: '+ Y', x: 180, y: 100, width: 16, height: 10, fontSize: 10 },
      { text: '2', x: 198, y: 96, width: 5, height: 7, fontSize: 7 },
      {
        text: ', ω = 0.0005π and the orbit is',
        x: 204,
        y: 100,
        width: 145,
        height: 10,
        fontSize: 10
      },
      {
        text: 'ωt : 0 → 2π. The measured range is reported below.',
        x: 50,
        y: 111,
        width: 250,
        height: 10,
        fontSize: 10
      }
    ]
  }
  const ownedLines = [
    { text: 'Y = r sin(ωt), r =', x: 50, y: 100, right: 349, bottom: 110, fontSize: 10 },
    {
      text: 'ωt : 0 → 2π. The measured range is reported below.',
      x: 50,
      y: 111,
      right: 300,
      bottom: 121,
      fontSize: 10
    }
  ]
  const caption = { lines: ownedLines.map(({ text }) => text), rect: [50, 100, 349, 121] }

  expect(nativeCaptionOwnedInlineFragments(page, caption, ownedLines)?.lines[0]).toBe(
    'Y = r sin(ωt), r = √ X² + Y² , ω = 0.0005π and the orbit is'
  )
})

it('retains a multi-baseline equation between prose fragments in an owned caption row', () => {
  const page = {
    lines: [
      {
        text: 'Figure 1: A plotted summary is described.',
        x: 60,
        y: 80,
        width: 280,
        height: 10,
        fontSize: 10
      },
      { text: 'The average output gradient', x: 60, y: 100, width: 140, height: 10, fontSize: 10 },
      { text: '1', x: 205, y: 98, width: 4, height: 7, fontSize: 7 },
      { text: 'n', x: 205, y: 106, width: 5, height: 7, fontSize: 7 },
      { text: 'P', x: 216, y: 92, width: 10, height: 10, fontSize: 10 },
      { text: 'n', x: 226, y: 98, width: 5, height: 7, fontSize: 7 },
      { text: 'k=1', x: 226, y: 106, width: 14, height: 7, fontSize: 7 },
      { text: '∂ f(x)', x: 242, y: 98, width: 20, height: 7, fontSize: 7 },
      { text: '∂x', x: 246, y: 106, width: 12, height: 7, fontSize: 7 },
      { text: '|', x: 264, y: 100, width: 3, height: 10, fontSize: 10 },
      { text: 'x', x: 268, y: 106, width: 5, height: 7, fontSize: 7 },
      { text: '(k) over training data.', x: 276, y: 100, width: 110, height: 10, fontSize: 10 },
      {
        text: 'The horizontal axis shows the tuning value.',
        x: 60,
        y: 111,
        width: 220,
        height: 10,
        fontSize: 10
      }
    ]
  }
  const ownedLines = [
    {
      text: 'Figure 1: A plotted summary is described.',
      x: 60,
      y: 80,
      right: 340,
      bottom: 90,
      fontSize: 10
    },
    { text: 'The average output gradient', x: 60, y: 100, right: 200, bottom: 110, fontSize: 10 },
    { text: '(k) over training data.', x: 276, y: 100, right: 386, bottom: 110, fontSize: 10 },
    {
      text: 'The horizontal axis shows the tuning value.',
      x: 60,
      y: 111,
      right: 280,
      bottom: 121,
      fontSize: 10
    }
  ]
  const caption = { lines: ownedLines.map(({ text }) => text), rect: [60, 80, 386, 121] }

  const recovered = nativeCaptionOwnedInlineFragments(page, caption, ownedLines)?.lines[1]
  expect(recovered).toContain('1 n P n k=1')
  expect(recovered).toContain('∂ f(x) ∂x | x (k)')
})

it('does not attach a raised digit when two baseline fragments compete for ownership', () => {
  const page = {
    lines: [
      { text: 'A measured value', x: 50, y: 100, width: 90, height: 10, fontSize: 10 },
      { text: 'Y', x: 143, y: 100, width: 5, height: 10, fontSize: 10 },
      { text: 'Y', x: 143, y: 100, width: 5, height: 10, fontSize: 10 },
      { text: '2', x: 150, y: 96, width: 5, height: 7, fontSize: 7 },
      { text: ' finishes the caption.', x: 157, y: 100, width: 120, height: 10, fontSize: 10 },
      {
        text: 'The following owned row remains complete.',
        x: 50,
        y: 111,
        width: 220,
        height: 10,
        fontSize: 10
      }
    ]
  }
  const ownedLines = [
    {
      text: 'A measured value Y finishes the caption.',
      x: 50,
      y: 100,
      right: 277,
      bottom: 110,
      fontSize: 10
    },
    {
      text: 'The following owned row remains complete.',
      x: 50,
      y: 111,
      right: 270,
      bottom: 121,
      fontSize: 10
    }
  ]

  expect(
    nativeCaptionOwnedInlineFragments(
      page,
      {
        lines: ownedLines.map(({ text }) => text),
        rect: [50, 100, 277, 121]
      },
      ownedLines
    )
  ).toBeUndefined()
})
