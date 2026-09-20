import { open } from 'node:fs/promises'
import { join } from 'node:path'

import {
  WSL_SETUP_GUIDE_ID,
  WSL_SETUP_GUIDE_VERSION,
  type WslSetupGuide
} from '../../shared/wsl-setup'

const GUIDE_FILE = 'wsl2-setup.md'
const VERSION_MARKER = `wsl-setup-guide-version: ${WSL_SETUP_GUIDE_VERSION}`
export const WSL_SETUP_GUIDE_MAX_BYTES = 64 * 1024

export const resolveWslSetupGuideCandidates = (
  resourcesPath = process.resourcesPath
): readonly string[] => [
  ...(resourcesPath
    ? [
        join(resourcesPath, 'app.asar.unpacked', 'resources', 'guides', GUIDE_FILE),
        join(resourcesPath, 'resources', 'guides', GUIDE_FILE)
      ]
    : []),
  join(__dirname, '../../../resources/guides', GUIDE_FILE),
  join(__dirname, '../../resources/guides', GUIDE_FILE)
]

export const loadWslSetupGuide = async (
  candidates: readonly string[] = resolveWslSetupGuideCandidates()
): Promise<WslSetupGuide> => {
  for (const candidate of candidates) {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(candidate, 'r')
      const info = await handle.stat()
      if (info.size > WSL_SETUP_GUIDE_MAX_BYTES) {
        return Object.freeze({
          id: WSL_SETUP_GUIDE_ID,
          version: WSL_SETUP_GUIDE_VERSION,
          status: 'version-mismatch'
        })
      }
      const markdown = await handle.readFile('utf8')
      if (markdown.split(/\r?\n/, 1)[0] !== `<!-- ${VERSION_MARKER} -->`) {
        return Object.freeze({
          id: WSL_SETUP_GUIDE_ID,
          version: WSL_SETUP_GUIDE_VERSION,
          status: 'version-mismatch'
        })
      }
      return Object.freeze({
        id: WSL_SETUP_GUIDE_ID,
        version: WSL_SETUP_GUIDE_VERSION,
        status: 'available',
        markdown
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    } finally {
      await handle?.close()
    }
  }
  return Object.freeze({
    id: WSL_SETUP_GUIDE_ID,
    version: WSL_SETUP_GUIDE_VERSION,
    status: 'missing'
  })
}
