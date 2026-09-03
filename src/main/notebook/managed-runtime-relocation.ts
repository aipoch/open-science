import type { NotebookLanguage } from '../../shared/notebook'
import type { RuntimeEnablement } from '../../shared/notebook-runtime'
import { relocatedPosixManagedRuntimeId } from './posix-runtime-binding'
import { relocatedWindowsManagedRuntimeId } from './windows-runtime-binding'

type RuntimeEnablementByLanguage = Partial<Record<NotebookLanguage, RuntimeEnablement>>

export const relocatedManagedRuntimeId = ({
  fromDataRoot,
  toDataRoot,
  language,
  platform,
  runtimeId
}: {
  fromDataRoot: string
  toDataRoot: string
  language: NotebookLanguage
  platform: NodeJS.Platform
  runtimeId: string
}): string | undefined => {
  const input = { fromDataRoot, toDataRoot, language, platform, runtimeId }
  return relocatedWindowsManagedRuntimeId(input) ?? relocatedPosixManagedRuntimeId(input)
}

export const relocateManagedRuntimeEnablement = ({
  enablement,
  fromDataRoot,
  toDataRoot,
  platform
}: {
  enablement: RuntimeEnablementByLanguage | undefined
  fromDataRoot: string
  toDataRoot: string
  platform: NodeJS.Platform
}): RuntimeEnablementByLanguage | undefined => {
  if (!enablement) return undefined

  const relocated = { ...enablement }
  let changed = false
  for (const language of ['python', 'r'] as const) {
    const current = enablement[language]
    if (!current) continue
    const enabled = { ...current.enabled }
    let languageChanged = false
    for (const [runtimeId, isEnabled] of Object.entries(current.enabled)) {
      if (isEnabled !== false) continue
      const nextRuntimeId = relocatedManagedRuntimeId({
        fromDataRoot,
        toDataRoot,
        language,
        platform,
        runtimeId
      })
      if (!nextRuntimeId || enabled[nextRuntimeId] === false) continue
      enabled[nextRuntimeId] = false
      languageChanged = true
    }
    if (!languageChanged) continue
    relocated[language] = {
      enabled,
      installAuthorized: { ...current.installAuthorized }
    }
    changed = true
  }
  return changed ? relocated : enablement
}
