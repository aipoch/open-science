import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const WEB_SERVICE_STATE_FILE = 'web-service.json'

export type WebServiceState = {
  pid: number
  port: number
  startedAt: string
  appVersion: string
  configRoot: string
  // True when the web service rides on an already-running instance (e.g. the desktop app), started on
  // demand via a second-instance --serve request. `stop` then only tears down the web service and must
  // never kill that pid — it is the user's app, not a daemon this launch owns. False for a dedicated
  // headless daemon, where stopping the web service means quitting the process.
  attached: boolean
}

const statePathFor = (configRoot: string): string => join(configRoot, WEB_SERVICE_STATE_FILE)

const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const readWebServiceState = async (configRoot: string): Promise<WebServiceState | undefined> => {
  const statePath = statePathFor(configRoot)
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8')) as WebServiceState
    if (
      !Number.isInteger(state.pid) ||
      !Number.isInteger(state.port) ||
      typeof state.startedAt !== 'string' ||
      typeof state.appVersion !== 'string' ||
      typeof state.configRoot !== 'string'
    ) {
      throw new Error('Invalid web service state.')
    }
    if (!isProcessAlive(state.pid)) {
      await rm(statePath, { force: true })
      return undefined
    }
    // Coerce attached so a state file written before this field existed reads as a dedicated daemon.
    return { ...state, attached: state.attached === true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    await rm(statePath, { force: true })
    return undefined
  }
}

const writeWebServiceState = async (
  configRoot: string,
  state: Omit<WebServiceState, 'configRoot'>
): Promise<WebServiceState> => {
  const completeState = { ...state, configRoot }
  const statePath = statePathFor(configRoot)
  const temporaryPath = `${statePath}.${process.pid}.tmp`
  await mkdir(dirname(statePath), { recursive: true })
  await writeFile(temporaryPath, `${JSON.stringify(completeState, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
  await rename(temporaryPath, statePath)
  return completeState
}

const removeWebServiceState = async (configRoot: string): Promise<void> => {
  await rm(statePathFor(configRoot), { force: true })
}

export {
  WEB_SERVICE_STATE_FILE,
  isProcessAlive,
  readWebServiceState,
  removeWebServiceState,
  statePathFor,
  writeWebServiceState
}
