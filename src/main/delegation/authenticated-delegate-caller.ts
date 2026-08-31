import type { SessionKey } from './session-records'

type AuthenticatedDelegateCaller = Readonly<{
  session: SessionKey
  frameId: string
  role: 'main' | 'delegate' | 'reviewer'
  parentSpecialistId?: string
  originMessageId: string
  toolInvocationId: string
  attemptId?: string
}>

export type { AuthenticatedDelegateCaller }
