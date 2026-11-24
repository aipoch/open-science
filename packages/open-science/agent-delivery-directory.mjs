/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { constants } from 'node:fs'
import { access, lstat, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const defaultAgentDeliveryDirectory = (profile) => join(profile, 'agent-delivery')

async function inspect(path, profile) {
  let checkedDirectory = path
  try {
    const target = await lstat(path).catch((error) => {
      if (error?.code === 'ENOENT') return undefined
      throw error
    })
    if (!target) checkedDirectory = profile
    if (!(target ?? (await stat(profile))).isDirectory()) {
      return { status: 'blocked', path, reason: 'delivery_directory_not_directory' }
    }
    await access(checkedDirectory, constants.W_OK | constants.X_OK)
    return { status: 'ready', path, checkedDirectory }
  } catch (error) {
    return ['EACCES', 'EPERM', 'EROFS'].includes(error?.code)
      ? { status: 'blocked', path, checkedDirectory, reason: 'delivery_directory_not_writable' }
      : { status: 'unconfirmed', path, reason: 'delivery_directory_unconfirmed' }
  }
}

export async function inspectAgentDeliveryDirectory(profile) {
  if (!profile) return { status: 'unconfirmed' }
  const path = defaultAgentDeliveryDirectory(profile)
  let timer
  const deadline = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve({ status: 'unconfirmed', path, reason: 'delivery_directory_unconfirmed' }),
      2000
    )
  })
  try {
    return await Promise.race([inspect(path, profile), deadline])
  } finally {
    clearTimeout(timer)
  }
}
