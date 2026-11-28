/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Only the Agent's choices are deterministic. Input materialization, Python execution,
// Notebook history and artifact publication cross the production MCP boundaries.
export const researchPrompt = 'Plot the attached measurements as a bar chart.'

export async function runResearchAnalysis(sessionId, prompt, withMcpClient, toolResult) {
  const inputBlock = prompt.match(
    /<open_science_notebook_inputs>\s*([\s\S]*?)\s*<\/open_science_notebook_inputs>/
  )
  const input =
    inputBlock && JSON.parse(inputBlock[1]).find((item) => item.filename === 'measurements.csv')
  if (!input)
    throw new Error('The uploaded measurements did not reach the Agent as a Notebook input.')
  const execution = await withMcpClient(sessionId, 'open-science-notebook', async (client) => {
    const { runtimes } = toolResult(
      'list_notebook_runtimes',
      await client.callTool({ name: 'list_notebook_runtimes', arguments: {} })
    )
    const python = runtimes.find(
      (runtime) =>
        runtime.language === 'python' && runtime.source === 'external' && runtime.runnable
    )
    if (!python) throw new Error('The explicitly enabled Python interpreter is unavailable.')
    toolResult(
      'notebook_bind_runtime',
      await client.callTool({
        name: 'notebook_bind_runtime',
        arguments: { language: 'python', runtimeId: python.runtimeId }
      })
    )
    return toolResult(
      'notebook_execute',
      await client.callTool(
        {
          name: 'notebook_execute',
          arguments: {
            language: 'python',
            code: `import csv
import xml.etree.ElementTree as ET

with open(${JSON.stringify(input.notebookPath)}, newline='', encoding='utf-8') as source:
    samples = list(csv.DictReader(source))

chart = ET.Element('svg', xmlns='http://www.w3.org/2000/svg', width='300', height=str(40 * len(samples)))
for index, sample in enumerate(samples):
    row = ET.SubElement(chart, 'g', transform=f'translate(0 {40 * index})')
    ET.SubElement(row, 'text', x='8', y='27').text = sample['sample']
    width = int(sample['value']) * 30
    ET.SubElement(row, 'rect', x='38', y='8', width=str(width), height='26', fill='teal')
    ET.SubElement(row, 'text', x=str(46 + width), y='27').text = sample['value']
ET.ElementTree(chart).write('measurements.svg', encoding='utf-8')`
          }
        },
        undefined,
        { timeout: 90_000 }
      )
    )
  })
  if (execution.status !== 'completed' || !execution.runId)
    throw new Error(`Python analysis failed: ${JSON.stringify(execution)}`)
  const stored = await withMcpClient(sessionId, 'open-science-artifacts', async (client) =>
    toolResult(
      'write_artifact_file',
      await client.callTool({
        name: 'write_artifact_file',
        arguments: {
          filename: 'measurements.svg',
          mimeType: 'image/svg+xml',
          source: { kind: 'localPath', path: 'measurements.svg' },
          producerRunId: execution.runId
        }
      })
    )
  )
  if (!stored.artifact?.version_id || stored.artifact.producer_run_id !== execution.runId)
    throw new Error('The chart was not published as a version of the producing Notebook run.')
  return 'Measurement chart published.'
}
