export interface KernelFenceMcpClient {
  callTool(request: unknown, options?: unknown, config?: unknown): Promise<unknown>
}

export const fencePrompt: string
export const retryFencePrompt: string
export function exerciseKernelFence(client: KernelFenceMcpClient, retry?: boolean): Promise<string>
