import { describe, expect, it } from 'vitest'

import { buildReactionMarkup } from './reaction-markup'

type BuildReactionArgs = Parameters<typeof buildReactionMarkup>

// A fake OpenChemLib whose Reaction returns stub molecules — lets us assert the layout logic
// (component count, "+" separators, arrow, unique ids) without depending on real OpenChemLib parsing.
const fakeOcl = (reactantCount: number, productCount: number): BuildReactionArgs[0] =>
  ({
    Reaction: {
      fromRxn: () => ({
        getReactants: () => reactantCount,
        getReactant: (index: number) => ({
          toSVG: (_w: number, _h: number, id: string) => `<svg id="${id}">reactant-${index}</svg>`
        }),
        getProducts: () => productCount,
        getProduct: (index: number) => ({
          toSVG: (_w: number, _h: number, id: string) => `<svg id="${id}">product-${index}</svg>`
        })
      })
    }
  }) as unknown as BuildReactionArgs[0]

const size = { width: 120, height: 90 }
const countMatches = (html: string, pattern: RegExp): number => (html.match(pattern) ?? []).length

describe('buildReactionMarkup', () => {
  it('lays out reactants and products separated by "+" and a single arrow', () => {
    const html = buildReactionMarkup(fakeOcl(2, 1), 'RXN', 'base', size)

    // 2 reactants + 1 product = 3 component depictions.
    expect(countMatches(html, /<svg/g)).toBe(3)
    // Exactly one reaction arrow.
    expect(countMatches(html, /→/g)).toBe(1)
    // One "+" between the two reactants; the single product needs none.
    expect(countMatches(html, />\+</g)).toBe(1)
    // Each component gets a unique svg id derived from the base id.
    expect(html).toContain('base-r0')
    expect(html).toContain('base-r1')
    expect(html).toContain('base-p0')
  })

  it('adds a "+" between multiple products and none for a lone reactant', () => {
    const html = buildReactionMarkup(fakeOcl(1, 2), 'RXN', 'b', size)

    expect(countMatches(html, /<svg/g)).toBe(3)
    // One "+" between the two products; the single reactant needs none.
    expect(countMatches(html, />\+</g)).toBe(1)
    expect(countMatches(html, /→/g)).toBe(1)
  })
})
