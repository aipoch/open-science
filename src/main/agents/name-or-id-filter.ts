import { agentsPublicError } from './agents-error'

type Nameable = { id: string; name?: string; displayName?: string }

export const applyNameOrIdFilter = <T extends Nameable>(
  entries: T[],
  nameOrId: unknown,
  method: string
): T[] => {
  const ref = typeof nameOrId === 'string' ? nameOrId : undefined
  if (!ref) return entries

  const byId = entries.filter((entry) => entry.id === ref)
  if (byId.length > 0) return byId

  const byName = entries.filter((entry) => entry.name === ref)
  if (byName.length === 0) {
    throw agentsPublicError(
      `No catalog entry matches "${ref}". Use the stable id from listSkills()/listConnectors().`
    )
  }
  if (byName.length > 1) {
    const ids = byName.map((entry) => entry.id).join(', ')
    throw agentsPublicError(
      `Multiple catalog entries match name "${ref}" (${ids}). Use the stable id from ${method} instead.`
    )
  }
  return byName
}
