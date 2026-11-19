import type { LabCheckRequest, LabSignInChallenge, LabView, SetLabServerRequest } from '../lab'
import { callable, LOCAL } from './definition'

// Lab is authenticated and driven entirely by the Electron main process. Every entry is LOCAL so the
// browser build installs a rejecting stub instead of exposing an enterprise credential flow there.
export const settingsLabContracts = {
  'settings.labBeginLogin': callable<() => Promise<LabSignInChallenge>>()('settings', [
    'settings:lab-begin-login',
    LOCAL
  ]),
  'settings.labCancelLogin': callable<() => Promise<LabView>>()('settings', [
    'settings:lab-cancel-login',
    LOCAL
  ]),
  'settings.labCheck': callable<(request?: LabCheckRequest) => Promise<LabView>>()('settings', [
    'settings:lab-check',
    LOCAL
  ]),
  'settings.labLogout': callable<() => Promise<LabView>>()('settings', [
    'settings:lab-logout',
    LOCAL
  ]),
  'settings.labRefresh': callable<() => Promise<LabView>>()('settings', [
    'settings:lab-refresh',
    LOCAL
  ]),
  'settings.labSetServer': callable<(request: SetLabServerRequest) => Promise<LabView>>()(
    'settings',
    ['settings:lab-set-server', LOCAL]
  ),
  'settings.labWaitLogin': callable<() => Promise<LabView>>()('settings', [
    'settings:lab-wait-login',
    LOCAL
  ])
} as const
