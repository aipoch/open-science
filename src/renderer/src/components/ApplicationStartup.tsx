import type { ReactNode } from 'react'
import { useSettingsStore } from '@/stores/settings-store'
import { RuntimeStartupGate } from './runtime-startup-gate'
import { DatabaseStartupGate } from './database-startup-gate'
import { SessionPackageOperation } from './SessionPackageOperation'

// Keep one presentation mounted while startup gates reveal the workspace underneath it.
export const ApplicationStartup = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const onboardingPending = useSettingsStore(
    (state) => !state.isLoaded || state.onboardingCompletedAt === undefined
  )
  return (
    <>
      <SessionPackageOperation deferImports={onboardingPending} />
      <RuntimeStartupGate>
        <DatabaseStartupGate>{children}</DatabaseStartupGate>
      </RuntimeStartupGate>
    </>
  )
}
