// The provider is deterministic; every result below comes from the real Notebook MCP server.
export const fencePrompt =
  '请为研究报告准备 PDF 工具：先用 inspect_packages 连续两次检查 reportlab 和 PyMuPDF；若内核启动被阻塞，仍分别尝试通过 manage_packages 安装这两个包和通过 manage_environments 创建名为 fence-check 的 Python 环境，逐项报告原始错误。不要使用系统 pip，不要删除记录或终止其他进程。'

export const retryFencePrompt =
  '请再次用 inspect_packages 检查 reportlab 和 PyMuPDF，只报告原始结果，不安装任何包。'

// JavaScript provider fixture: matches the existing fake-opencode.mjs lint convention.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export async function exerciseKernelFence(client, retry = false) {
  const calls = [
    {
      name: 'inspect_packages',
      arguments: { language: 'python', packages: ['reportlab', 'PyMuPDF'] }
    }
  ]
  if (!retry)
    calls.push(
      calls[0],
      {
        name: 'manage_packages',
        arguments: { language: 'python', packages: ['reportlab', 'PyMuPDF'] }
      },
      {
        name: 'manage_environments',
        arguments: { action: 'create', language: 'python', name: 'fence-check' }
      }
    )
  const results = []
  const first = await client.callTool(calls[0], undefined, { timeout: 60_000 })
  results.push({ tool: calls[0].name, result: first })
  if (retry) return `Kernel fence retry: ${JSON.stringify(results)}`

  const second = await client.callTool(calls[1], undefined, { timeout: 60_000 })
  results.push({ tool: calls[1].name, result: second })
  // The fixed path must never install packages as part of the regression test. If the fence is
  // gone, the read-only probe reaches the next independent runtime error and the mutating calls
  // are deliberately omitted. The legacy blocked path still exercises all four real calls.
  if (!JSON.stringify(first).includes('KERNEL_STARTUP_FENCE')) {
    return `Kernel fence results: ${JSON.stringify(results)}`
  }
  for (const call of calls.slice(2)) {
    const result = await client.callTool(call, undefined, { timeout: 60_000 })
    results.push({ tool: call.name, result })
  }
  return `Kernel fence ${retry ? 'retry' : 'results'}: ${JSON.stringify(results)}`
}
