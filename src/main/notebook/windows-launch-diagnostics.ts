/** Stable launch failure categories for the Windows Electron-as-Node boundary.
 *
 * Classifies caller-provided stderr into a stable recovery category. This helper does not retain
 * or return the original text; diagnostic reporting remains the caller's responsibility.
 */
export type WindowsLaunchDiagnosticCategory = 'nul-initialization-unavailable' | 'unknown'

export const classifyWindowsLaunchDiagnostic = (input: {
  platform: NodeJS.Platform
  stderr?: string
}): WindowsLaunchDiagnosticCategory => {
  if (input.platform !== 'win32' || !input.stderr) return 'unknown'
  const text = input.stderr.toLowerCase()
  return text.includes('unable to open nul device needed for initialization') ||
    text.includes('--no-stdio-init')
    ? 'nul-initialization-unavailable'
    : 'unknown'
}
