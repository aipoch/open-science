import { access } from 'node:fs/promises'

import type { LocalDrive } from '../../shared/local-fs'

const isWindowsPlatform = (platform: NodeJS.Platform): boolean => platform === 'win32'

const listWindowsDrives = async (): Promise<LocalDrive[]> => {
  const drives: LocalDrive[] = []
  for (let code = 65; code <= 90; code += 1) {
    const letter = String.fromCharCode(code)
    try {
      await access(`${letter}:\\`)
      drives.push({ path: `${letter}:\\`, label: `${letter}:` })
    } catch {
      // Letter not mounted.
    }
  }
  return drives
}

export { isWindowsPlatform, listWindowsDrives }
