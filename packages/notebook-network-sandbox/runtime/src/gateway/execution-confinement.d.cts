/** Main-owned ceiling. Membership never grants access; the normal policy still decides. */
export type ExecutionConfinement = Readonly<{
  mode: 'offline-demo' | 'research'
  allowedNetworkHosts?: readonly string[]
}>

export declare const normalizeExecutionConfinement: (
  input: ExecutionConfinement
) => ExecutionConfinement

export declare const executionConfinementAllowsHost: (
  confinement: ExecutionConfinement,
  host: string
) => boolean
