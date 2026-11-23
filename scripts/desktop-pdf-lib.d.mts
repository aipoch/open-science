export function shareDesktopPdfLibPako(stage: string, installed: Map<string, string>): Promise<void>

export function stageDesktopPdfLib(
  manifest: { name: string; version?: string },
  source: string,
  destination: string
): Promise<boolean>
