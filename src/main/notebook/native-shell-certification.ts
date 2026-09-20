import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { NotebookProcessSandbox } from './process-sandbox'
import { runShellCommand } from './shell-process'

/** Run the production shell path inside an isolated packaged-app smoke session. */
export const certifyNativeShell = async (input: {
  appPackaged: boolean
  headless: boolean
  storageRoot: string
  environment: NodeJS.ProcessEnv
  processSandbox: NotebookProcessSandbox
}): Promise<void> => {
  if (input.environment.OPEN_SCIENCE_E2E_NATIVE_SHELL_CERTIFICATION !== '1') return
  const root = input.environment.OPEN_SCIENCE_E2E_STORAGE_ROOT
  if (
    !input.appPackaged ||
    !input.headless ||
    process.platform !== 'darwin' ||
    !root ||
    !isAbsolute(root) ||
    resolve(root) !== resolve(input.storageRoot)
  ) {
    throw new Error('Native shell certification requires an isolated packaged macOS session.')
  }
  const cwd = await mkdtemp(join(root, 'native-shell-certification-'))
  let cleanupVerified = false
  try {
    const execute = (command: string, timeoutMs = 5_000): ReturnType<typeof runShellCommand> =>
      runShellCommand({
        command,
        cwd,
        handoffDir: cwd,
        runtimeRoot: cwd,
        sessionId: 'native-shell-certification',
        projectId: 'native-shell-certification',
        timeoutMs,
        processSandbox: input.processSandbox
      })
    // The command leader exits with a live descendant. Successful cleanup must stop that descendant.
    const first = await execute('sleep 30 & printf "%s" "$!"')
    const pid = Number(first.stdout.trim())
    if (first.exitCode !== 0 || first.errorCode || !Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error(`Native shell descendant certification failed: ${JSON.stringify(first)}`)
    }
    try {
      process.kill(pid, 0)
      throw new Error('Native shell certification left its descendant running.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    const timedOut = await execute('sleep 30', 100)
    if (
      timedOut.exitCode !== null ||
      timedOut.errorCode ||
      timedOut.ownedTreeReaped === false ||
      !timedOut.stderr.includes('timed out')
    ) {
      throw new Error(`Native shell timeout certification failed: ${JSON.stringify(timedOut)}`)
    }
    const second = await execute('printf ready')
    if (second.exitCode !== 0 || second.stdout !== 'ready' || second.errorCode) {
      throw new Error(`Native shell reuse certification failed: ${JSON.stringify(second)}`)
    }
    cleanupVerified = true
    await writeFile(
      join(root, 'native-shell-certification.json'),
      JSON.stringify({ status: 'passed' })
    )
  } catch (error) {
    await writeFile(
      join(root, 'native-shell-certification.json'),
      JSON.stringify({
        status: 'failed',
        error: error instanceof Error ? error.message : String(error)
      })
    )
    throw error
  } finally {
    // Preserve the fixture if the real lifecycle could not certify teardown.
    if (cleanupVerified) await rm(cwd, { recursive: true, force: true })
  }
}
