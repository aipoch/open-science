import { vi } from 'vitest'

type TestHighlightRegistry = Map<string, Set<Range>>

class TestHighlight extends Set<Range> {
  constructor(...ranges: Range[]) {
    super(ranges)
  }
}

const installCssHighlightsMock = (): TestHighlightRegistry => {
  const highlights: TestHighlightRegistry = new Map()
  vi.stubGlobal('Highlight', TestHighlight)
  vi.stubGlobal('CSS', { highlights })
  return highlights
}

export { installCssHighlightsMock }
export type { TestHighlightRegistry }
