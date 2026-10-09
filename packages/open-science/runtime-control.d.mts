export function requestExistingRuntimeWeb(
  options: { configRoot?: string; port?: number; credentialStore?: 'os' | 'file' },
  fetch?: typeof globalThis.fetch
): Promise<string | undefined>
