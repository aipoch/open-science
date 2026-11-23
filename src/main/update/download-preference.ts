import { lstatSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DownloadPreference } from './strategy'

// A missing opt-out marker is the same default for existing and freshly created profiles.
// Failure to read the profile never authorizes a background transfer.
export function profileDownloadPreference(profile: string): DownloadPreference {
  const marker = join(profile, 'disable-background-update-downloads')
  let enabled = false
  try {
    lstatSync(marker)
  } catch (error) {
    enabled = (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
  return {
    get enabled() {
      return enabled
    },
    setEnabled(next: boolean) {
      if (enabled === next) return
      if (next) {
        try {
          unlinkSync(marker)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      } else {
        writeFileSync(marker, '', { flag: 'wx' })
      }
      enabled = next
    }
  }
}
