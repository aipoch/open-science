export function stageDesktopDependencyChain(
  manifest: { name: string; version?: string; dependencies?: Record<string, string> },
  source: string,
  destination: string
): Promise<Set<string> | undefined>
export function assertPrivateDependencyChain(name: string, included: Set<string>): void
