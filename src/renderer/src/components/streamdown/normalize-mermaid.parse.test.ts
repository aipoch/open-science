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
