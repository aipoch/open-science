/* eslint-disable @typescript-eslint/explicit-function-return-type -- JavaScript agent fixture. */
// Deterministic agent decisions only; all runtime discovery, package inspection, Python and
// publication use the running application's production MCP transport and handlers.
export async function macAcceptance(sessionId, prompt, withMcpClient, toolResult) {
  const marker = 'MACOS_ACCEPTANCE_REQUEST:'
  const input = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length).trim())
  const evidence = await withMcpClient(sessionId, 'open-science-notebook', async (client) => {
    const call = async (name, args = {}) =>
      toolResult(
        name,
        await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })
      )
    const listed = await call('list_notebook_runtimes')
    const runtime = listed.runtimes.find(
      (r) => r.language === 'python' && r.provenance === 'app-managed' && r.runnable
    )
    if (!runtime) throw new Error('No ready managed Python: ' + JSON.stringify(listed))
    // Implicit default binding exercises the path that previously failed on package admission.
    const packages = await call('inspect_packages', {
      language: 'python',
      packages: ['pip', 'numpy']
    })
    const installation = await call('manage_packages', { language: 'python', packages: ['numpy'] })
    if (installation.ok !== true)
      throw new Error('Package management failed: ' + JSON.stringify(installation))
    const run = await call('notebook_execute', { language: 'python', code: input.code })
    if (run.status !== 'completed') throw new Error('Python failed: ' + JSON.stringify(run))
    return { runtime, packages, installation, run }
  })
  if (input.publish) {
    evidence.publication = await withMcpClient(
      sessionId,
      'open-science-artifacts',
      async (client) =>
        toolResult(
          'write_artifact_file',
          await client.callTool({
            name: 'write_artifact_file',
            arguments: {
              filename: 'research-summary.md',
              mimeType: 'text/markdown',
              source: { kind: 'localPath', path: 'research-summary.md' },
              producerRunId: evidence.run.runId
            }
          })
        )
    )
    if (evidence.publication.artifact?.producer_run_id !== evidence.run.runId)
      throw new Error('Missing producer attribution')
  }
  return `MACOS_ACCEPTANCE_OK ${input.stage}\n${JSON.stringify(evidence)}`
}
