import { nodeRuntimeEnvironment } from '../node-process-host'
import {
  runVerificationProcess,
  VerificationProcessExitError
} from '../update/verification-process'

// Resolve npm shims before calling this helper; script entries need Electron's Node mode.
export const runClaudeCli = async (
  resolvedPath: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv
    signal: AbortSignal
    timeoutMs: number
    preserveChildrenOnExit?: boolean
  }
): Promise<{ stdout: string; stderr: string; code: number | null }> => {
  const script = /\.(js|mjs)$/i.test(resolvedPath)
  try {
    const output = await runVerificationProcess(
      script ? process.execPath : resolvedPath,
      [...(script ? [resolvedPath] : []), ...args],
      {
        ...options,
        // Browser authentication can still be active before stdin receives anything.
        stdin: 'pipe',
        preserveChildrenOnExit: options.preserveChildrenOnExit,
        env: script ? { ...options.env, ...nodeRuntimeEnvironment() } : options.env
      }
    )
    return { ...output, code: 0 }
  } catch (error) {
    if (error instanceof VerificationProcessExitError) {
      return { stdout: error.stdout, stderr: error.stderr, code: error.exitCode }
    }
    throw error
  }
}
