import type { Prisma } from '@prisma/client'
import { parseSmartRule } from '../../shared/smart-collection-rule'

// Called in the same transaction that creates or advances the collection rule.
export async function saveSmartRuleVersion(
  tx: Prisma.TransactionClient,
  collectionId: string
): Promise<void> {
  const definition = await tx.literatureSmartCollection.findUniqueOrThrow({
    where: { collectionId },
    include: { collection: true }
  })
  const fields = parseSmartRule(definition.collection.description)
  if (!fields) throw new Error('Invalid structured collection rule.')
  await tx.literatureSmartRuleRevision.create({
    data: {
      collectionId,
      revision: definition.ruleRevision,
      description: fields.description,
      inclusionCriteria: fields.inclusion,
      exclusionCriteria: fields.exclusion,
      scopeKind: definition.scopeKind,
      scopeId: definition.scopeId,
      evidenceMode: definition.evidenceMode
    }
  })
}
