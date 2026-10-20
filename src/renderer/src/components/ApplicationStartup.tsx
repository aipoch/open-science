import type { ReactNode } from 'react'
import { RuntimeStartupGate } from './runtime-startup-gate'
import { DatabaseStartupGate } from './database-startup-gate'
import { SessionPackageOperation } from './SessionPackageOperation'

// Keep one presentation mounted while startup gates reveal the workspace underneath it.
export const ApplicationStartup = ({ children }: { children: ReactNode }): React.JSX.Element => (
  <>
    <SessionPackageOperation />
    <RuntimeStartupGate>
      <DatabaseStartupGate>{children}</DatabaseStartupGate>
    </RuntimeStartupGate>
  </>
)
