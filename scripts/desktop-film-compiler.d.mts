export function privateFilmDirectories(
  stage: string,
  film: string,
  edges: Map<string, Map<string, string>>,
  inputs: string[]
): string[] | undefined
export function bundleDesktopFilmCompiler(
  stage: string,
  edges: Map<string, Map<string, string>>
): Promise<void>
