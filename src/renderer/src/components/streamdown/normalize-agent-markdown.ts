const quoteAxisListItems = (raw: string): string =>
  raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      if (item.startsWith('"') || item.startsWith("'")) return item
      if (/^-?\d+(\.\d+)?$/.test(item)) return item
      return `"${item.replace(/^["']|["']$/g, '')}"`
    })
    .join(', ')

const normalizeXychartLine = (line: string): string[] => {
  const titleAndXAxis = line.match(/^\s*"([^"]+)"\s+x-axis\s+\[(.+)\]\s*$/i)
  if (titleAndXAxis) {
    return [
      `    title "${titleAndXAxis[1]}"`,
      `    x-axis [${quoteAxisListItems(titleAndXAxis[2])}]`
    ]
  }

  const bareTitle = line.match(/^\s*"([^"]+)"\s*$/)
  if (bareTitle && !/^\s*title\b/i.test(line)) {
    return [`    title "${bareTitle[1]}"`]
  }

  const xAxis = line.match(/^(\s*x-axis\s+)\[(.+)\]\s*$/i)
  if (xAxis) {
    return [`${xAxis[1]}[${quoteAxisListItems(xAxis[2])}]`]
  }

  return [line]
}

/** Fix common AI mistakes in xychart-beta blocks before Mermaid parses them. */
const normalizeMermaidChart = (source: string): string => {
  if (!/^\s*xychart-beta\b/im.test(source)) return source

  const lines = source.split('\n').flatMap((line) => normalizeXychartLine(line))
  return lines.join('\n')
}

const normalizeMermaidBlocks = (markdown: string): string =>
  markdown.replace(/```mermaid[^\n]*\n([\s\S]*?)```/g, (block, chart: string) =>
    block.replace(chart, normalizeMermaidChart(chart))
  )

/** GitHub-style alerts: > [!NOTE] → styled aside (ChatGPT/Cursor/Claude docs style). */
const normalizeGfmAlerts = (markdown: string): string =>
  markdown.replace(
    /^>\s*\[!([A-Z]+)\]\s*\r?\n((?:>\s?.+\r?\n?)+)/gim,
    (_match, type: string, body: string) => {
      const content = body
        .split(/\r?\n/)
        .map((line) => line.replace(/^>\s?/, ''))
        .join('\n')
        .trim()

      return `<aside data-agent-alert="${type.toLowerCase()}">\n\n${content}\n\n</aside>\n\n`
    }
  )

/** Normalize agent markdown before Streamdown parses it. */
const normalizeAgentMarkdown = (markdown: string): string =>
  normalizeMermaidBlocks(normalizeGfmAlerts(markdown))

export { normalizeAgentMarkdown, normalizeGfmAlerts, normalizeMermaidChart }
