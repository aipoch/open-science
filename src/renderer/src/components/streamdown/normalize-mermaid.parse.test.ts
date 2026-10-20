// @vitest-environment jsdom
import mermaid from 'mermaid'
import { expect, it } from 'vitest'

import { normalizeMermaidChart } from './normalize-agent-markdown'

it.each([
  '"Control, untreated", "Treatment"',
  '"Control", "Treatment"',
  '"Control, untreated", Treatment'
])('keeps axis labels parseable by Mermaid: %s', async (labels) => {
  const source = `xychart-beta
 x-axis [${labels}]
 y-axis "Value" 0 --> 10
 bar [3, 7]`
  await expect(mermaid.parse(source)).resolves.toBeTruthy()
  await expect(mermaid.parse(normalizeMermaidChart(source))).resolves.toBeTruthy()
})

it('retains the installed parser error formats used to suppress futile retries', async () => {
  await expect(mermaid.parse('graph TD\n A --> ]')).rejects.toThrow(/^Lexical error on line \d+\./)
  await expect(mermaid.parse('graph TD\n A[')).rejects.toThrow(/^Parse error on line \d+:/)
  await expect(mermaid.parse('not a diagram')).rejects.toThrow(
    /^No diagram type detected matching given configuration for text:/
  )
})
