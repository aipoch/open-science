import type { LocalShellRuntimePreference, WslSelection } from '../../shared/wsl-setup'

type LocalShellRuntimeMutation = Readonly<{
  revision: number
  runtime: LocalShellRuntimePreference
  previous: LocalShellRuntimePreference | undefined
  previousActivatedWslSelection?: WslSelection
}>

export type { LocalShellRuntimeMutation }
