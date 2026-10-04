import {
  researchMembershipSchema,
  type PersistedChatSession,
  type ResearchMembership
} from '../../shared/session-persistence'

export type ResearchMembershipSourceReader = (
  projectId: string,
  sessionId: string
) => Promise<
  { status: 'found'; session: PersistedChatSession } | { status: 'missing' | 'unreadable' }
>

// Called while the receiving Project lane is held: source deletion/archive and this write cannot
// interleave. The source import receipt distinguishes separate local imports of the same package.
export async function resolveResearchMembership(
  receiver: Pick<PersistedChatSession, 'projectId' | 'id'>,
  input: ResearchMembership,
  read: ResearchMembershipSourceReader
): Promise<ResearchMembership> {
  const membership = researchMembershipSchema.parse(input)
  if (receiver.projectId !== membership.sourceProjectId)
    throw new Error('Research discussions must belong to the same Project as their source.')
  if (receiver.id === membership.sourceSessionId)
    throw new Error('A research source cannot be its own discussion.')
  const source = await read(membership.sourceProjectId, membership.sourceSessionId)
  if (
    source.status !== 'found' ||
    source.session.projectId !== receiver.projectId ||
    source.session.id !== membership.sourceSessionId ||
    source.session.packageOrigin?.importId !== membership.sourceImportId ||
    source.session.archivedAt !== undefined
  )
    throw new Error('The imported research source is unavailable or has changed.')
  return { ...membership, sourceTitle: source.session.title }
}
