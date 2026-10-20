/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Only the Agent's choices are deterministic. Input materialization, Python execution,
// Notebook history and artifact publication cross the production MCP boundaries.
export const researchPrompt = 'Analyze the attached measurements and save a research report.'

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
            code: [
              'import csv, statistics',
              'from pathlib import Path',
              `with open(${JSON.stringify(input.notebookPath)}, newline='', encoding='utf-8') as source:`,
              "    measurements = [float(row['value']) for row in csv.DictReader(source)]",
              "report = f'# Research results\\n\\nSamples: {len(measurements)}\\n\\nMean: {statistics.mean(measurements):.2f}\\n'",
              "Path('research-results.md').write_text(report, encoding='utf-8')",
              'print(report)'
            ].join('\n')
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
          filename: 'research-results.md',
          mimeType: 'text/markdown',
          source: { kind: 'localPath', path: 'research-results.md' },
          producerRunId: execution.runId
        }
      })
    )
  )
  if (stored.artifact?.producer_run_id !== execution.runId)
    throw new Error('The research report lost its Notebook producer.')
  return `Research analysis complete.\n\n${execution.stdout}`
}
