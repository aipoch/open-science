import { win32 } from 'node:path'

// Windows PowerShell 5.1 is an OS component with a stable location beneath the Windows root.
// Resolve it directly so a damaged or intentionally minimal PATH cannot block managed runtimes,
// notebook shell commands, or other security-sensitive operations that depend on PowerShell.
export const resolveWindowsPowerShellExecutable = (
  env: NodeJS.ProcessEnv = process.env
): string => {
  const windowsRoot = env.SystemRoot || env.WINDIR
  if (!windowsRoot) {
    throw new Error('Cannot resolve Windows PowerShell: SystemRoot and WINDIR are unavailable')
  }
  return win32.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}
