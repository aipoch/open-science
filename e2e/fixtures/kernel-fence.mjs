/* eslint-disable @typescript-eslint/explicit-function-return-type -- JavaScript agent fixture. */
// The provider dispatches each requested action once through the real Notebook MCP server.
export const kernelRecoveryRequest = 'WINDOWS_KERNEL_RECOVERY_REQUEST:'

export async function exerciseKernelRecovery(client, prompt, toolResult) {
  // The fixture request occupies one line. The agent can append context to the prompt.
  const input = JSON.parse(
    prompt
      .slice(prompt.lastIndexOf(kernelRecoveryRequest) + kernelRecoveryRequest.length)
      .split(/\r?\n/u, 1)[0]
  )
  const call = async (name, args) =>
    toolResult(
      name,
      await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 })
    )
  if (input.runtimeId) {
    const binding = await call('notebook_bind_runtime', {
      language: 'python',
      runtimeId: input.runtimeId
    })
    if (binding.bound?.runtimeId !== input.runtimeId)
      throw new Error(`Incorrect Python binding: ${JSON.stringify(binding)}`)
    return 'Windows Notebook prepared.'
  }
  const run = await call('notebook_execute', {
    language: 'python',
    code: input.code,
    cellId: input.stage
  })
  if (run.status !== 'completed')
    throw new Error(`Windows Notebook execution failed: ${JSON.stringify(run)}`)
  return `Windows Notebook ${input.stage}: ${JSON.stringify(run)}`
}
