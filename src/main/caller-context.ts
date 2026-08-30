export type CallerSurface = 'electron' | 'web' | 'task'
export type CallerLocation = 'local' | 'remote'
export type CallerPrincipalKind = 'human' | 'automation' | 'agent-session'
export type CallerActionOrigin = 'human' | 'automation' | 'agent-session'
export type CallerAuthority = 'manage-remote-pairing'

export type CallerContext = Readonly<{
  clientId: string
  lifecycleClientId: string
  leaseId: string
  surface: CallerSurface
  location: CallerLocation
  principalKind: CallerPrincipalKind
  actionOrigin: CallerActionOrigin
  authorities: readonly CallerAuthority[]
  isAuthorizationCurrent: () => boolean
}>

type CreateCallerContextInput = Omit<CallerContext, 'authorities' | 'isAuthorizationCurrent'> & {
  authorities?: readonly CallerAuthority[]
  isAuthorizationCurrent?: () => boolean
}

type CreateWebCallerContextOptions = Partial<
  Pick<CallerContext, 'location' | 'principalKind' | 'actionOrigin'>
> & {
  authorities?: readonly CallerAuthority[]
  isAuthorizationCurrent?: () => boolean
}

type CreateTaskCallerContextOptions = Partial<Pick<CallerContext, 'clientId' | 'location'>> & {
  isAuthorizationCurrent?: () => boolean
}

const alwaysCurrent = (): boolean => true

const createCallerContext = (input: CreateCallerContextInput): CallerContext =>
  Object.freeze({
    ...input,
    authorities: Object.freeze([...new Set(input.authorities ?? [])]),
    isAuthorizationCurrent: input.isAuthorizationCurrent ?? alwaysCurrent
  })

const createElectronCallerContext = (senderId: number): CallerContext =>
  createCallerContext({
    clientId: String(senderId),
    lifecycleClientId: `electron:${senderId}`,
    leaseId: `electron:${senderId}`,
    surface: 'electron',
    location: 'local',
    principalKind: 'human',
    actionOrigin: 'human'
  })

const createWebCallerContext = (
  clientId: string,
  options: CreateWebCallerContextOptions = {}
): CallerContext =>
  createCallerContext({
    clientId,
    lifecycleClientId: `web:${clientId}`,
    leaseId: clientId,
    surface: 'web',
    location: options.location ?? 'local',
    principalKind: options.principalKind ?? 'human',
    actionOrigin: options.actionOrigin ?? 'human',
    authorities: options.authorities,
    isAuthorizationCurrent: options.isAuthorizationCurrent
  })

const createTaskCallerContext = (options: CreateTaskCallerContextOptions = {}): CallerContext => {
  const clientId = options.clientId ?? 'headless-task-api'
  return createCallerContext({
    clientId,
    lifecycleClientId: `web:${clientId}`,
    leaseId: clientId,
    surface: 'task',
    location: options.location ?? 'local',
    principalKind: 'automation',
    actionOrigin: 'automation',
    isAuthorizationCurrent: options.isAuthorizationCurrent
  })
}

const hasCallerAuthority = (context: CallerContext, authority: CallerAuthority): boolean =>
  context.isAuthorizationCurrent() && context.authorities.includes(authority)

const canSatisfyHumanApproval = (context: CallerContext): boolean =>
  context.isAuthorizationCurrent() &&
  context.principalKind === 'human' &&
  context.actionOrigin === 'human'

const canAccessSessionPlan = (context: CallerContext): boolean =>
  context.isAuthorizationCurrent() &&
  ((context.principalKind === 'human' && context.actionOrigin === 'human') ||
    (context.surface === 'task' &&
      context.principalKind === 'automation' &&
      context.actionOrigin === 'automation'))

export type ClientLease = Readonly<{
  clientId: string
  release: () => void
}>

type CallerEvent = {
  sender: {
    id: number
  }
}

const nativeCallerContexts = new WeakMap<object, CallerContext>()

const callerContextForEvent = (event: CallerEvent): CallerContext => {
  if (event.sender.id <= 0) throw new Error('Electron caller sender id must be positive.')
  const sender = event.sender as object
  const existing = nativeCallerContexts.get(sender)
  if (existing) return existing
  const context = createElectronCallerContext(event.sender.id)
  nativeCallerContexts.set(sender, context)
  return context
}

export class ClientLeaseRegistry {
  private readonly leasesByClient = new Map<string, Set<symbol>>()
  private disposed = false

  constructor(private readonly releaseClient: (clientId: string) => void) {}

  acquire(clientId: string): ClientLease {
    if (this.disposed) throw new Error('Client lease registry is disposed.')
    const token = Symbol(clientId)
    const leases = this.leasesByClient.get(clientId) ?? new Set<symbol>()
    leases.add(token)
    this.leasesByClient.set(clientId, leases)
    let released = false

    return Object.freeze({
      clientId,
      release: () => {
        if (released) return
        released = true
        const active = this.leasesByClient.get(clientId)
        if (!active?.delete(token) || active.size > 0) return
        this.leasesByClient.delete(clientId)
        this.releaseClient(clientId)
      }
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const clientIds = [...this.leasesByClient.keys()]
    this.leasesByClient.clear()
    const failures: unknown[] = []
    for (const clientId of clientIds) {
      try {
        this.releaseClient(clientId)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Client lease cleanup failed.')
  }
}

export {
  callerContextForEvent,
  canAccessSessionPlan,
  canSatisfyHumanApproval,
  createCallerContext,
  createElectronCallerContext,
  createTaskCallerContext,
  createWebCallerContext,
  hasCallerAuthority
}
