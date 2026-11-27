export interface KernelRecoveryMcpClient {
  callTool(request: unknown, options?: unknown, config?: unknown): Promise<unknown>
}

export const kernelRecoveryRequest: string
export function exerciseKernelRecovery(
  client: KernelRecoveryMcpClient,
  prompt: string,
  toolResult: (name: string, result: unknown) => unknown
): Promise<string>
