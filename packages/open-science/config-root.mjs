/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'

export const DEV_CONFIG_DIR = '.open-science-project'
export const PROD_CONFIG_DIR = '.open-science'
export const STATE_FILE = 'web-service.json'
export const TOKEN_FILE = 'web-token'

const exists = async (path) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export const resolveConfigRoot = ({ packaged = false, override, env = process.env } = {}) => {
  const requested = override ?? env.OPEN_SCIENCE_CONFIG_ROOT ?? env.OPEN_SCIENCE_STORAGE_ROOT
  if (requested) {
    if (!isAbsolute(requested)) throw new Error('The config root must be an absolute path.')
    return normalize(requested)
  }
  return join(homedir(), packaged ? PROD_CONFIG_DIR : DEV_CONFIG_DIR)
}

export const candidateConfigRoots = ({ override, env = process.env } = {}) => {
  if (override ?? env.OPEN_SCIENCE_CONFIG_ROOT ?? env.OPEN_SCIENCE_STORAGE_ROOT) {
    return [resolveConfigRoot({ override, env })]
  }
  return [resolveConfigRoot({ packaged: false, env }), resolveConfigRoot({ packaged: true, env })]
}

export const readStateFromRoot = async (configRoot) => {
  try {
    const state = JSON.parse(await readFile(join(configRoot, STATE_FILE), 'utf8'))
    if (
      !Number.isInteger(state.pid) ||
      !Number.isInteger(state.port) ||
      typeof state.startedAt !== 'string'
    ) {
      return undefined
    }
    return { ...state, configRoot: state.configRoot || configRoot }
  } catch {
    return undefined
  }
}

export const findServiceState = async (options = {}) => {
  for (const configRoot of candidateConfigRoots(options)) {
    if (!(await exists(join(configRoot, STATE_FILE)))) continue
    const state = await readStateFromRoot(configRoot)
    if (state) return state
  }
  return undefined
}

export const readWebToken = async (configRoot) =>
  (await readFile(join(configRoot, TOKEN_FILE), 'utf8')).trim()
