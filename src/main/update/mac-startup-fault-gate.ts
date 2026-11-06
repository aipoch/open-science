import { existsSync } from 'node:fs'
import { writeDurableJsonFile } from '@aipoch/durable-files'
import { isAbsolute, join, relative, sep } from 'node:path'
import { macEntryFaultInjectionEnabled } from '../mac-ordinary-entry'
import { installationStateDirectory, type InstallationLocation } from './installation-protection'

/** Diagnostic-only pause after the same production data/window verification and before its
 * durable completion. This never writes a success state or changes the installation algorithm. */
export async function pauseMacVerifiedStartup(
  location: InstallationLocation,
  operationId: string | undefined,
  profilePath: string
): Promise<void> {
  if (
    !operationId ||
    process.env.OPEN_SCIENCE_MAC_STARTUP_PAUSE_AT !== 'verified-ready' ||
    !macEntryFaultInjectionEnabled(location.installationRoot)
  )
    return
  const releaseFile = process.env.OPEN_SCIENCE_MAC_STARTUP_RELEASE_FILE
  const stateRoot = location.stateRoot ?? process.env.OPEN_SCIENCE_INSTALLATION_STATE_ROOT
  const offset = releaseFile && stateRoot ? relative(stateRoot, releaseFile) : undefined
  if (
    !releaseFile ||
    !isAbsolute(releaseFile) ||
    !offset ||
    offset === '..' ||
    offset.startsWith(`..${sep}`) ||
    isAbsolute(offset)
  )
    throw new Error('The diagnostic startup pause requires an isolated release file.')
  if (existsSync(releaseFile))
    throw new Error('The diagnostic startup release file already exists.')
  const directory = installationStateDirectory(location)
  await writeDurableJsonFile(
    join(directory, 'mac-verified-ready-pause.json'),
    JSON.stringify({
      phase: 'verified-ready-before-cleanup',
      operationId,
      pid: process.pid,
      installationRoot: location.installationRoot,
      profilePath,
      time: Date.now()
    }) + '\n'
  )
  const deadlineAt = Date.now() + 90_000
  while (!existsSync(releaseFile)) {
    if (Date.now() >= deadlineAt)
      throw new Error('The diagnostic verified startup pause timed out.')
    await new Promise((done) => setTimeout(done, 20))
  }
}
