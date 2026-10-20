import {
  SkillAuthoringService,
  type SkillAuthoringCatalog,
  type SkillAuthoringSummary
} from '@aipoch/skills'
import type { TrustedCallingSession } from '../../shared/agents-contract'
import { validateSkillHelper } from './helper-validation'

export type HostSkillsResult =
  | Awaited<ReturnType<SkillAuthoringService['list' | 'read' | 'validate' | 'edit' | 'publish']>>
  | { status: 'declined'; operation: 'delete' }
  | { status: 'deleted'; operation: 'delete'; name: string }

type Options = {
  storageRoot: string
  catalog: SkillAuthoringCatalog
  approveDelete?: (
    request: { name: string; origin: SkillAuthoringSummary['origin'] },
    context: TrustedCallingSession
  ) => Promise<boolean>
  onPublishedSkillsChanged?: () => Promise<void> | void
}
const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

/** Adapts host.skills RPC, session approval and post-commit refresh to package authoring. */
export class HostSkillsService {
  private readonly authoring: SkillAuthoringService
  constructor(private readonly options: Options) {
    this.authoring = new SkillAuthoringService({
      storageRoot: options.storageRoot,
      catalog: options.catalog,
      validateHelper: validateSkillHelper
    })
  }

  async dispatch(request: unknown, context: TrustedCallingSession = {}): Promise<HostSkillsResult> {
    const value = request && typeof request === 'object' ? (request as Record<string, unknown>) : {}
    const op = asString(value.op)
    const params =
      value.params && typeof value.params === 'object' && !Array.isArray(value.params)
        ? (value.params as Record<string, unknown>)
        : {}
    const name = asString(params.name) ?? ''
    try {
      if (op === 'list') return await this.authoring.list()
      if (op === 'read') {
        try {
          return await this.authoring.read({ name, path: asString(params.path) })
        } catch (error) {
          if (error instanceof Error && error.message === `Unknown Skill: ${name.trim()}`) {
            throw new Error(
              `${error.message}. host.skills reads managed and draft Skills, not generated Connector Skill documents. Use an already loaded document or the current framework's advertised Skill loader. If unavailable, stop the dependent work; do not probe filesystem paths or guess Connector methods.`,
              { cause: error }
            )
          }
          throw error
        }
      }
      if (op === 'validate') return await this.authoring.validate({ name })
      return await this.authoring.runMutationExclusive(async () => {
        if (op === 'edit') {
          if (!name.trim()) throw new Error('name is required')
          const content = asString(params.content)
          if (content === undefined) throw new Error('content is required')
          return this.authoring.edit({
            name,
            path: asString(params.path),
            content,
            ...(Object.hasOwn(params, 'old_string')
              ? { oldString: asString(params.old_string) }
              : {})
          })
        }
        if (op === 'publish') {
          if (params.overwrite !== undefined && typeof params.overwrite !== 'boolean')
            throw new Error('overwrite must be a boolean')
          const result = await this.authoring.publish({
            name,
            overwrite: params.overwrite as boolean | undefined
          })
          try {
            await this.options.onPublishedSkillsChanged?.()
          } catch (error) {
            throw new Error(
              `Skill "${result.id}" was published and its draft removed, but catalog refresh failed. ` +
                `Use host.skills.read(${JSON.stringify(result.id)}) to inspect the published Skill; ` +
                'do not republish to retry refresh. Availability in agent contexts has not been confirmed.',
              { cause: error }
            )
          }
          return result
        }
        if (op === 'delete') {
          const target = await this.authoring.resolveDeletion(name)
          const approved = await this.options.approveDelete?.(
            { name: target.name, origin: target.origin },
            context
          )
          if (!approved) return { status: 'declined', operation: 'delete' }
          await this.authoring.delete(target.id)
          if (target.origin !== 'draft') {
            try {
              await this.options.onPublishedSkillsChanged?.()
            } catch (error) {
              throw new Error(
                `Skill "${target.id}" was deleted, but catalog refresh failed. ` +
                  'Use host.skills.list() to inspect the catalog; do not repeat deletion to retry refresh. ' +
                  'Removal from agent contexts has not been confirmed.',
                { cause: error }
              )
            }
          }
          return { status: 'deleted', operation: 'delete', name: target.name }
        }
        throw new Error('Unknown operation')
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failure = new Error(
        `host.skills.${op ?? 'unknown'}: ${message.replace(/(['"])(?:[A-Za-z]:\\|\/)[^'"]+\1/g, '<path>')}`,
        { cause: error }
      )
      failure.name = 'HostSkillsCallError'
      throw failure
    }
  }
}
