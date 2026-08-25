/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'vite'

const require = createRequire(import.meta.url)
const electronExecutable = require('electron')
const scriptPath = fileURLToPath(import.meta.url)
const workspaceRoot = resolve(dirname(scriptPath), '..')
const cacheRoot = join(workspaceRoot, 'node_modules', '.cache')
const terminationGraceMs = 3_000
const groupExitTimeoutMs = 1_000
const groupExitPollIntervalMs = 25
const storageRootEnvironmentVariable = 'OPEN_SCIENCE_VERSION_FILE_OPERATOR_STORAGE_ROOT'

class ProcessTreeExitUnconfirmedError extends Error {
  treeExitUnconfirmed = true
}

const processTreeExitError = (message, options) =>
  new ProcessTreeExitUnconfirmedError(message, options)

const observeExit = (child) =>
  new Promise((resolveExit, rejectExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit({ code: child.exitCode, signal: child.signalCode })
      return
    }

    const onError = (error) => {
      child.removeListener('exit', onExit)
      rejectExit(error)
    }
    const onExit = (code, signal) => {
      child.removeListener('error', onError)
      resolveExit({ code, signal })
    }
    child.once('error', onError)
    child.once('exit', onExit)
  })

const delay = (milliseconds) =>
  new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds)
  })

const waitForExitWithin = async (exit, milliseconds) => {
  let timeout
  const result = await Promise.race([
    exit.then(() => true),
    new Promise((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout(false), milliseconds)
      timeout.unref?.()
    })
  ])
  if (timeout) clearTimeout(timeout)
  return result
}

const signalProcessGroup = (pid, signal) => {
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

export const waitForPosixProcessGroupExit = async (
  pid,
  {
    processGroupExists = (groupId) => signalProcessGroup(groupId, 0),
    delay: wait = delay,
    timeoutMs = groupExitTimeoutMs,
    pollIntervalMs = groupExitPollIntervalMs,
    failureMessage = `Unable to confirm Electron contract process group ${pid} exited after SIGKILL.`
  } = {}
) => {
  const maximumPolls = Math.ceil(timeoutMs / pollIntervalMs)
  for (let poll = 0; poll <= maximumPolls; poll += 1) {
    if (!processGroupExists(pid)) return
    if (poll === maximumPolls) break
    await wait(pollIntervalMs)
  }
  throw processTreeExitError(failureMessage)
}

export const terminatePosixProcessTree = async (
  child,
  {
    signalProcessGroup: signalGroup = signalProcessGroup,
    waitForExitWithin: waitForExit = waitForExitWithin,
    waitForProcessGroupExit = waitForPosixProcessGroupExit,
    terminationTimeoutMs = terminationGraceMs
  } = {}
) => {
  if (child.pid === undefined) return

  const exit = observeExit(child)
  signalGroup(child.pid, 'SIGTERM')
  const exitedAfterTerm = await waitForExit(exit, terminationTimeoutMs)

  // xvfb-run can exit before Electron or Xvfb. Escalate the whole detached group, then confirm the
  // group disappeared before the runner releases either temporary root.
  const groupSurvivedTerm = signalGroup(child.pid, 0)
  if (groupSurvivedTerm) signalGroup(child.pid, 'SIGKILL')
  if (!exitedAfterTerm && !(await waitForExit(exit, terminationTimeoutMs))) {
    throw processTreeExitError(
      `Unable to confirm Electron contract wrapper ${child.pid} exited after SIGKILL.`
    )
  }
  if (groupSurvivedTerm) {
    try {
      await waitForProcessGroupExit(child.pid)
    } catch (error) {
      if (error?.treeExitUnconfirmed === true) throw error
      throw processTreeExitError(String(error instanceof Error ? error.message : error), {
        cause: error
      })
    }
  }
}

const spawnTaskkill = (pid) =>
  spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true
  })

export const terminateWindowsProcessTree = async (
  child,
  {
    spawnTaskkill: startTaskkill = spawnTaskkill,
    waitForExitWithin: waitForExit = waitForExitWithin,
    terminationTimeoutMs = terminationGraceMs
  } = {}
) => {
  if (child.pid === undefined) return

  const exit = observeExit(child)
  const failClosed = async (message, cause) => {
    try {
      child.kill('SIGKILL')
    } catch {
      // The wrapper may already have exited while taskkill was settling.
    }
    await waitForExit(exit, terminationTimeoutMs).catch(() => false)
    throw processTreeExitError(message, cause === undefined ? undefined : { cause })
  }

  let taskkill
  try {
    taskkill = startTaskkill(child.pid)
  } catch (error) {
    await failClosed(
      'Unable to confirm Electron contract process-tree exit: taskkill.exe failed.',
      error
    )
    return
  }

  const taskkillExit = observeExit(taskkill)
  let taskkillCompleted = false
  try {
    taskkillCompleted = await waitForExit(taskkillExit, terminationTimeoutMs)
  } catch (error) {
    await failClosed(
      'Unable to confirm Electron contract process-tree exit: taskkill.exe failed.',
      error
    )
    return
  }
  if (!taskkillCompleted) {
    try {
      taskkill.kill()
    } catch {
      // A timed-out taskkill may have exited between the bounded wait and this fallback.
    }
    await waitForExit(taskkillExit, terminationTimeoutMs).catch(() => false)
    await failClosed('Unable to confirm Electron contract process-tree exit: taskkill.exe hung.')
    return
  }

  let taskkillResult
  try {
    taskkillResult = await taskkillExit
  } catch (error) {
    await failClosed(
      'Unable to confirm Electron contract process-tree exit: taskkill.exe failed.',
      error
    )
    return
  }
  if (taskkillResult.code !== 0 || taskkillResult.signal !== null) {
    const taskkillOutcome = taskkillResult.signal
      ? `exited with signal ${taskkillResult.signal}`
      : `returned ${String(taskkillResult.code)}`
    await failClosed(
      `Unable to confirm Electron contract process-tree exit: taskkill.exe ${taskkillOutcome}.`
    )
    return
  }
  if (!(await waitForExit(exit, terminationTimeoutMs))) {
    throw processTreeExitError(
      `Unable to confirm Electron contract wrapper ${child.pid} exited after taskkill.exe.`
    )
  }
}

export const confirmElectronContractProcessTreeExit = async (
  child,
  {
    platform = process.platform,
    waitForExitWithin: waitForExit = waitForExitWithin,
    waitForProcessGroupExit = waitForPosixProcessGroupExit,
    confirmationTimeoutMs = terminationGraceMs
  } = {}
) => {
  const exit = observeExit(child)
  if (!(await waitForExit(exit, confirmationTimeoutMs))) {
    throw processTreeExitError(
      `Unable to confirm Electron contract wrapper ${child.pid ?? '(no pid)'} exited.`
    )
  }

  // On Windows the direct child is the Electron app itself (there is no xvfb-run wrapper). The
  // contract calls app.exit(), whose Electron lifecycle owns its helper processes; Node has no
  // reliable detached-descendant query, so the bounded direct-child exit is the confirmable boundary.
  if (platform === 'win32' || child.pid === undefined) return

  try {
    await waitForProcessGroupExit(child.pid, {
      failureMessage: `Unable to confirm Electron contract process group ${child.pid} exited after its wrapper.`
    })
  } catch (error) {
    if (error?.treeExitUnconfirmed === true) throw error
    throw processTreeExitError(String(error instanceof Error ? error.message : error), {
      cause: error
    })
  }
}

export const terminateElectronContractProcessTree = async (child) => {
  if (process.platform === 'win32') await terminateWindowsProcessTree(child)
  else await terminatePosixProcessTree(child)
}

export const waitForElectronContractProcess = async (
  child,
  { timeoutMs = 30_000, terminateProcessTree = terminateElectronContractProcessTree } = {}
) => {
  const exit = observeExit(child)
  const timedOut = Symbol('timed-out')
  let timeout
  let result
  try {
    result = await Promise.race([
      exit,
      new Promise((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(timedOut), timeoutMs)
        timeout.unref?.()
      })
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }

  if (result === timedOut) {
    await terminateProcessTree(child)
    await exit
    throw new Error(
      `VersionFileOperator Electron contract timed out after ${timeoutMs} milliseconds.`
    )
  }

  const { code, signal } = result
  if (code !== 0) {
    throw new Error(
      `VersionFileOperator Electron contract failed with ${signal ? `signal ${signal}` : `exit code ${String(code)}`}.`
    )
  }
}

const spawnElectron = (entryPath, storageRoot) => {
  const electronEnvironment = { ...process.env }
  delete electronEnvironment.ELECTRON_RUN_AS_NODE
  electronEnvironment[storageRootEnvironmentVariable] = storageRoot

  // Headless Linux runners need a display server even though this contract opens no windows.
  const useVirtualDisplay = process.platform === 'linux' && !electronEnvironment.DISPLAY
  const command = useVirtualDisplay ? 'xvfb-run' : electronExecutable
  const args = useVirtualDisplay ? ['-a', electronExecutable, entryPath] : [entryPath]
  return spawn(command, args, {
    cwd: workspaceRoot,
    detached: process.platform !== 'win32',
    env: electronEnvironment,
    stdio: 'inherit',
    windowsHide: true
  })
}

const buildContractBundle = async (outputDirectory) => {
  await build({
    appType: 'custom',
    configFile: false,
    logLevel: 'warn',
    root: workspaceRoot,
    build: {
      emptyOutDir: true,
      outDir: outputDirectory,
      ssr: resolve(workspaceRoot, 'scripts/version-file-operator-electron-contract.ts'),
      target: 'node22',
      rollupOptions: {
        output: { entryFileNames: 'contract.mjs' }
      }
    }
  })
}

const addProcessSignalHandler = (signal, handler) => process.on(signal, handler)
const removeProcessSignalHandler = (signal, handler) => process.off(signal, handler)
const exitWithProcessSignal = (signal) => process.kill(process.pid, signal)

export const runVersionFileOperatorElectronContract = async ({
  prepareCacheRoot = () => mkdir(cacheRoot, { recursive: true }),
  createTemporaryRoot = (prefix) => mkdtemp(join(cacheRoot, prefix)),
  buildContractBundle: bundleContract = buildContractBundle,
  spawnElectronContract = spawnElectron,
  terminateProcessTree = terminateElectronContractProcessTree,
  confirmProcessTreeExit = confirmElectronContractProcessTreeExit,
  processTimeoutMs = 30_000,
  addTerminationSignalHandler = addProcessSignalHandler,
  removeTerminationSignalHandler = removeProcessSignalHandler,
  exitWithSignal = exitWithProcessSignal,
  reportFailure = (error) => console.error(error),
  removeTemporaryRoot = (path) => rm(path, { recursive: true, force: true })
} = {}) => {
  let buildRoot
  let storageRoot
  let activeChild
  let requestedSignal
  let terminationPromise
  let treeExitConfirmed = true
  let failure

  // Signal and timeout paths share this memoized promise, so concurrent teardown requests can never
  // launch taskkill twice or race two POSIX group-kill sequences.
  const terminateActiveChild = () => {
    if (!activeChild) return Promise.resolve()
    terminationPromise ??= Promise.resolve().then(() => terminateProcessTree(activeChild))
    return terminationPromise
  }
  const requestSignal = (signal) => {
    requestedSignal ??= signal
    void terminateActiveChild().catch(() => undefined)
  }
  const sigintHandler = () => requestSignal('SIGINT')
  const sigtermHandler = () => requestSignal('SIGTERM')
  const joinStartedTermination = async () => {
    if (!terminationPromise) return false
    try {
      await terminationPromise
      treeExitConfirmed = true
    } catch (error) {
      treeExitConfirmed = false
      failure = error
    }
    return true
  }

  addTerminationSignalHandler('SIGINT', sigintHandler)
  addTerminationSignalHandler('SIGTERM', sigtermHandler)
  try {
    await prepareCacheRoot()
    buildRoot = await createTemporaryRoot('version-file-operator-electron-build-')
    storageRoot = await createTemporaryRoot('version-file-operator-electron-storage-')
    const outputDirectory = join(buildRoot, 'bundle')
    await bundleContract(outputDirectory)

    if (!requestedSignal) {
      activeChild = spawnElectronContract(join(outputDirectory, 'contract.mjs'), storageRoot)
      try {
        await waitForElectronContractProcess(activeChild, {
          timeoutMs: processTimeoutMs,
          terminateProcessTree: terminateActiveChild
        })
      } catch (error) {
        failure = error
      }
      if (!(await joinStartedTermination())) {
        try {
          await confirmProcessTreeExit(activeChild)
        } catch (error) {
          treeExitConfirmed = false
          failure =
            error?.treeExitUnconfirmed === true
              ? error
              : processTreeExitError(String(error instanceof Error ? error.message : error), {
                  cause: error
                })
        }
        // A signal can arrive while normal process-tree confirmation is awaiting its bounded poll.
        // Join the memoized teardown before cleanup or restoring the original signal semantics.
        await joinStartedTermination()
      }
      activeChild = undefined
    }
  } catch (error) {
    failure = error
  }

  // A failed tree confirmation deliberately preserves both roots: Electron/Xvfb may still hold the
  // bundle or immutable storage open, and deleting either would hide the leak and race live processes.
  if (treeExitConfirmed) {
    try {
      await Promise.all([
        ...(storageRoot ? [removeTemporaryRoot(storageRoot)] : []),
        ...(buildRoot ? [removeTemporaryRoot(buildRoot)] : [])
      ])
    } catch (error) {
      failure ??= error
    }
  }
  removeTerminationSignalHandler('SIGINT', sigintHandler)
  removeTerminationSignalHandler('SIGTERM', sigtermHandler)

  if (requestedSignal) {
    if (!treeExitConfirmed && failure) reportFailure(failure)
    exitWithSignal(requestedSignal)
    return
  }
  if (!treeExitConfirmed) throw failure
  if (failure) throw failure
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  await runVersionFileOperatorElectronContract()
}
