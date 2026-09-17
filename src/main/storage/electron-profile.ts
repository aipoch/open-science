import { lstatSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { resolveConfigRootOverride } from './config-root'
export { resolveBootstrapConfigRoot } from './config-root'

export type ProfileLocationOptions = {
  appData: string
  configRoot: string
  packaged: boolean
  env?: NodeJS.ProcessEnv
}

// Electron owns profile creation. Only check that an explicitly selected path can be a directory;
// do not infer initialization state or persist a separate choice alongside settings.
const validateProfilePath = (path: string): string => {
  // Find the first existing directory entry, not just a resolvable target. A broken link at the
  // leaf or an ancestor is recovery evidence, never permission to create a replacement profile.
  let ancestor = path
  while (true) {
    try {
      lstatSync(ancestor)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor)
        throw error
      ancestor = dirname(ancestor)
      continue
    }
    try {
      if (!statSync(ancestor).isDirectory()) throw new Error('The path is not a directory.')
    } catch (cause) {
      throw new Error(
        `The selected Electron profile is not a directory or has an unavailable link: ${path}. Reconnect or restore ${ancestor} before restarting.`,
        { cause }
      )
    }
    break
  }
  return path
}

// Read-only before the single-instance lock. A profile path is independent of the credential
// identity: keep the original directory when present, even if the new credential name is selected.
export const resolveElectronProfile = (options: ProfileLocationOptions): string => {
  const env = options.env ?? process.env
  const explicit = env.OPEN_SCIENCE_USER_DATA?.trim()
  if (explicit) {
    if (!isAbsolute(explicit)) throw new Error('OPEN_SCIENCE_USER_DATA must be an absolute path.')
    return validateProfilePath(normalize(explicit))
  }
  if (resolveConfigRootOverride(options.packaged, env)) {
    return validateProfilePath(join(options.configRoot, 'electron-profile'))
  }
  const suffix = options.packaged ? '' : ' (DEV)'
  const legacy = join(options.appData, 'Open Science' + suffix)
  // lstat observes broken links too: never redirect an unavailable old profile to a new directory.
  try {
    lstatSync(legacy)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return validateProfilePath(join(options.appData, 'Open-Science' + suffix))
  }
  return validateProfilePath(legacy)
}
