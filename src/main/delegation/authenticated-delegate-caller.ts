import type { SessionKey } from './session-records'

type AuthenticatedDelegateCaller = Readonly<{
  session: SessionKey
  frameId: string
  role: 'main' | 'delegate' | 'reviewer'
  parentSpecialistId?: string
  /** Trusted root runtime execution; never supplied by the agent. */
  rootExecutionId?: string
  originMessageId: string
  toolInvocationId: string
  /** Main-owned execution policy, never read from agent request input. */
  permissionPrompts?: 'none'
  attemptId?: string
}>

export type { AuthenticatedDelegateCaller }
