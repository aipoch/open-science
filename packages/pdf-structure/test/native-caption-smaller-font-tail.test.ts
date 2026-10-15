import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)

it('keeps a closed figure caption when its explanatory rows use a smaller font', () => {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [
      {
        text: 'Figure 1: A detailed model overview with its main components and measured outputs',
        x: 60,
        y: 100,
        width: 250,
        right: 310,
        height: 10,
        fontSize: 10
      },
      {
        text: 'The first panel compares the reference model with an independently measured baseline,',
        x: 60,
        y: 111,
        width: 220,
        right: 280,
        height: 7,
        fontSize: 7
      },
      {
        text: 'while the second panel reports the resulting error over all evaluation cases.',
        x: 60,
        y: 121,
        width: 240,
        right: 300,
        height: 7,
        fontSize: 7
      }
    ],
    graphicsBounds: [
      {
        kind: 'image',
        normalizedRect: [0.09, 0.02, 0.53, 0.125]
      }
    ]
  }

  expect(findCaptionCandidates([page])[0]?.lines).toEqual(page.lines.map(({ text }) => text))
})

it('keeps a compact plot caption whose abbreviated lead continues in a smaller font', () => {
  const page = {
    pageNumber: 1,
    width: 612,
    height: 792,
    lines: [
      {
        text: 'Figure 1: Acceptance rate for a model w.r.t.',
        x: 110,
        y: 183,
        right: 300,
        width: 190,
        height: 10,
        fontSize: 10
      },
      {
        text: 'model class A on a synthetic data set',
        x: 110,
        y: 194,
        right: 300,
        width: 190,
        height: 9,
        fontSize: 9
      },
      {
        text: 'over repeated runs with parameter δ = 0.1.',
        x: 110,
        y: 204,
        right: 255,
        width: 145,
        height: 9,
        fontSize: 9
      }
    ],
    graphicsBounds: [{ kind: 'image', normalizedRect: [0.207, 0.09, 0.465, 0.226] }]
  }

  expect(findCaptionCandidates([page])[0]?.lines).toEqual(page.lines.map(({ text }) => text))
})

it('does not extend a compact caption without one matching plot above it', () => {
  const page = {
    pageNumber: 1,
    width: 612,
    height: 792,
    lines: [
      {
        text: 'Figure 1: Acceptance rate for a model w.r.t.',
        x: 110,
        y: 183,
        right: 300,
        width: 190,
        height: 10,
        fontSize: 10
      },
      {
        text: 'model class A on a synthetic data set',
        x: 110,
        y: 194,
        right: 300,
        width: 190,
        height: 9,
        fontSize: 9
      },
      {
        text: 'over repeated runs with parameter δ = 0.1.',
        x: 110,
        y: 204,
        right: 255,
        width: 145,
        height: 9,
        fontSize: 9
      }
    ],
    graphicsBounds: []
  }

  expect(findCaptionCandidates([page])[0]?.lines).toEqual([page.lines[0].text])
})

it('keeps a hyphenated table-title continuation above its ruled header', () => {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [
      {
        text: 'Table 2. Mean score across the independent evalua-',
        x: 108,
        y: 471,
        width: 380,
        right: 488,
        height: 12,
        fontSize: 12
      },
      {
        text: 'tion groups',
        x: 137,
        y: 485,
        width: 50,
        right: 187,
        height: 12,
        fontSize: 12
      },
      {
        text: 'Model Group Score',
        x: 140,
        y: 514,
        width: 309,
        right: 449,
        height: 12,
        fontSize: 12
      }
    ],
    graphicsBounds: [{ kind: 'path', normalizedRect: [0.21, 0.637, 0.785, 0.645] }]
  }

  expect(findCaptionCandidates([page])[0]?.lines).toEqual(
    page.lines.slice(0, 2).map(({ text }) => text)
  )
})

it('does not complete a hyphenated table title without a ruled table header', () => {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [
      {
        text: 'Table 2. Mean score across the independent evalua-',
        x: 108,
        y: 471,
        width: 380,
        right: 488,
        height: 12,
        fontSize: 12
      },
      {
        text: 'tion groups',
        x: 137,
        y: 485,
        width: 50,
        right: 187,
        height: 12,
        fontSize: 12
      },
      {
        text: 'Model Group Score',
        x: 140,
        y: 514,
        width: 309,
        right: 449,
        height: 12,
        fontSize: 12
      }
    ],
    graphicsBounds: []
  }

  expect(findCaptionCandidates([page])[0]?.lines).toEqual([page.lines[0].text])
})

it('does not borrow a neighboring column rule and header to finish a table title', () => {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [
      {
        text: 'Table 2. Measured performance across the indepen-',
        x: 50,
        y: 471,
        width: 200,
        right: 250,
        height: 12,
        fontSize: 12
      },
      {
        text: 'continued discussion of the previous experiment',
        x: 79,
        y: 485,
        width: 420,
        right: 499,
        height: 12,
        fontSize: 12
      },
      {
        text: 'Separate Table Header',
        x: 350,
        y: 514,
        width: 200,
        right: 550,
        height: 12,
        fontSize: 12
      }
    ],
    graphicsBounds: [{ kind: 'path', normalizedRect: [0.567, 0.636, 0.933, 0.641] }]
  }

  expect(findCaptionCandidates([page])[0]?.lines).toEqual([page.lines[0].text])
})
