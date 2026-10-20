import { type Prisma, type PrismaClient } from '@prisma/client'
import {
  LiteratureSmartCollections,
  ClassificationEvaluationError as ScreeningEvaluationError,
  AutomaticClassificationPausedError as ScreeningPausedError,
  type ScreeningDatabase,
  type ScreeningStore,
  type ReadScreeningEvidence,
  type SmartScope
} from '@aipoch/literature-screening'
import {
  AutomaticClassificationPausedError,
  ClassificationEvaluationError,
  type ClassificationSnapshot,
  type ClassifyLiterature
} from '../../shared/classification'
import { acquireDataRootWriter } from '../storage/migration-state'
import { screeningDatabase, screeningStore, screeningScope } from './screening-store'

type Client = PrismaClient | Prisma.TransactionClient
/** Connect one screening state owner to host transactions and classification settings. */
export function createLiteratureScreening(
  getClient: () => Promise<PrismaClient>,
  classifier: {
    subscribe?: (listener: () => void) => () => void
    snapshot(): Promise<ClassificationSnapshot>
    classifyLiterature: ClassifyLiterature
  },
  onChanged: (id: string) => void,
  readEvidence?: ReadScreeningEvidence
): LiteratureScreening {
  const databases = new WeakMap<PrismaClient, ScreeningDatabase>()
  const database = async (): Promise<ScreeningDatabase> => {
    const client = await getClient()
    let store = databases.get(client)
    if (!store) {
      store = screeningDatabase(client)
      databases.set(client, store)
    }
    return store
  }
  const context = async (client?: Client): Promise<ScreeningStore | undefined> =>
    client ? (client === (await getClient()) ? database() : screeningStore(client)) : undefined
  const owner = new LiteratureSmartCollections(
    database,
    {
      subscribe: classifier.subscribe?.bind(classifier),
      policy: async () => {
        const snapshot = await classifier.snapshot()
        const binding = snapshot.smartCollections
        const service = snapshot.services.find((entry) => entry.id === binding?.serviceId)
        return {
          key: JSON.stringify([
            binding?.serviceId,
            binding?.modelId,
            service?.adapter,
            service?.baseUrl,
            'literature-choice-v1'
          ]),
          configured: Boolean(binding && service?.configured),
          model: binding?.modelId
        }
      },
      classifyLiterature: async (input) => {
        try {
          return await classifier.classifyLiterature(input)
        } catch (error) {
          if (error instanceof ClassificationEvaluationError)
            throw new ScreeningEvaluationError(error.category)
          if (error instanceof AutomaticClassificationPausedError)
            throw new ScreeningPausedError(error.reason)
          throw error
        }
      }
    },
    onChanged,
    readEvidence,
    acquireDataRootWriter
  )
  return {
    start: () => owner.start(),
    dispose: () => owner.dispose(),
    schedule: () => owner.schedule(),
    policy: () => owner.policy(),
    view: (...args: Parameters<typeof owner.view>) => owner.view(...args),
    execute: async (...args: Parameters<typeof owner.execute>) => {
      try {
        return await owner.execute(...args)
      } catch (error) {
        if (error instanceof ScreeningEvaluationError)
          throw new ClassificationEvaluationError(error.category)
        if (error instanceof ScreeningPausedError)
          throw new AutomaticClassificationPausedError(error.reason)
        throw error
      }
    },
    ruleUpdated: (id: string) => owner.ruleUpdated(id),
    deleteCollection: <T>(id: string, remove: () => Promise<T>) =>
      owner.deleteCollection(id, remove),
    scope: (client: Client, scope: SmartScope) => screeningScope(client, scope),
    decisions: async (id: string, itemIds: string[], client?: Client) =>
      owner.decisions(id, itemIds, await context(client)),
    members: async (
      id: string,
      client?: Client,
      filter?: Parameters<typeof owner.members>[2],
      source?: Parameters<typeof owner.members>[3]
    ) => owner.members(id, await context(client), filter, source),
    matchingCollections: async (itemId?: string, projectId?: string, client?: Client) =>
      owner.matchingCollections(itemId, projectId, await context(client)),
    memberships: async (itemIds: string[], client?: Client) =>
      owner.memberships(itemIds, await context(client))
  }
}
export type LiteratureScreening = Pick<
  LiteratureSmartCollections,
  | 'start'
  | 'dispose'
  | 'schedule'
  | 'policy'
  | 'view'
  | 'execute'
  | 'ruleUpdated'
  | 'deleteCollection'
> & {
  scope(client: Client, scope: SmartScope): ReturnType<typeof screeningScope>
  decisions(
    id: string,
    itemIds: string[],
    client?: Client
  ): ReturnType<LiteratureSmartCollections['decisions']>
  members(
    id: string,
    client?: Client,
    filter?: Parameters<LiteratureSmartCollections['members']>[2],
    source?: Parameters<LiteratureSmartCollections['members']>[3]
  ): ReturnType<LiteratureSmartCollections['members']>
  matchingCollections(
    itemId?: string,
    projectId?: string,
    client?: Client
  ): ReturnType<LiteratureSmartCollections['matchingCollections']>
  memberships(
    itemIds: string[],
    client?: Client
  ): ReturnType<LiteratureSmartCollections['memberships']>
}
