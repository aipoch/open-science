import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { readDurableJsonFile, writeDurableJsonFile } from '../storage/durable-json-file'

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

const decodeWebServiceState = (contents: string): WebServiceState => {
  const state = JSON.parse(contents) as WebServiceState
  if (
    !Number.isInteger(state.pid) ||
    !Number.isInteger(state.port) ||
    typeof state.startedAt !== 'string' ||
    typeof state.appVersion !== 'string' ||
    typeof state.configRoot !== 'string'
  ) {
    throw new Error('Invalid web service state.')
  }
  return { ...state, attached: state.attached === true }
}

const readWebServiceState = async (configRoot: string): Promise<WebServiceState | undefined> => {
  const statePath = statePathFor(configRoot)
  try {
    const result = await readDurableJsonFile(statePath, decodeWebServiceState)
    if (result.status === 'missing') return undefined
    const state = result.value
    if (!isProcessAlive(state.pid)) {
      await rm(statePath, { force: true })
      return undefined
    }
    return state
  } catch {
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
  await writeDurableJsonFile(statePath, `${JSON.stringify(completeState, null, 2)}\n`)
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
