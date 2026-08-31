import type {
  CreateTagRequest,
  DeleteTagRequest,
  ReorderTagsRequest,
  SetTagAssignmentRequest,
  TagSnapshot,
  TagResourceRef,
  UpdateTagRequest
} from '../../shared/tags'
import type { ApplicationEventPublisher } from '../application-events'
import type { TagRepository } from './repository'
import type { TagResourceCatalog } from './resource-catalog'

class TagService {
  private revision = 0
  private mutationQueue: Promise<void> = Promise.resolve()
  private readonly pendingResourceDeletions = new Map<string, TagResourceRef>()

  constructor(
    private readonly repository: TagRepository,
    private readonly resources: TagResourceCatalog,
    private readonly events: Pick<ApplicationEventPublisher, 'publish'>
  ) {}

  private mutate(operation: () => Promise<void>): Promise<TagSnapshot> {
    const result = this.mutationQueue.then(async () => {
      await operation()
      this.revision += 1
      this.events.publish('tags:changed', { revision: this.revision })
      return this.repository.snapshot(this.revision)
    })
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  snapshot(): Promise<TagSnapshot> {
    const result = this.mutationQueue.then(async () => {
      const pending = [...this.pendingResourceDeletions.values()]
      if (pending.length > 0) {
        const removed = await this.repository.removeResourceAssignments(pending)
        for (const reference of pending)
          this.pendingResourceDeletions.delete(this.resourceKey(reference))
        if (removed > 0) {
          this.revision += 1
          this.events.publish('tags:changed', { revision: this.revision })
        }
      }
      const resources = await this.resources.snapshot()
      const pruned = await this.repository.pruneStaleAssignments(resources)
      if (pruned > 0) {
        this.revision += 1
        this.events.publish('tags:changed', { revision: this.revision })
      }
      return this.repository.snapshot(this.revision)
    })
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  create(request: CreateTagRequest): Promise<TagSnapshot> {
    return this.mutate(() => this.repository.create(request))
  }

  update(request: UpdateTagRequest): Promise<TagSnapshot> {
    return this.mutate(() => this.repository.update(request))
  }

  delete(request: DeleteTagRequest): Promise<TagSnapshot> {
    return this.mutate(() => this.repository.delete(request.id))
  }

  reorder(request: ReorderTagsRequest): Promise<TagSnapshot> {
    return this.mutate(() => this.repository.reorder(request))
  }

  setAssignment(request: SetTagAssignmentRequest): Promise<TagSnapshot> {
    return this.mutate(async () => {
      if (request.assigned && !(await this.resources.exists(request))) {
        throw new Error('Tag resource no longer exists.')
      }
      await this.repository.setAssignment(request)
    })
  }

  async removeResources(resources: readonly TagResourceRef[]): Promise<void> {
    for (const reference of resources) {
      this.pendingResourceDeletions.set(this.resourceKey(reference), reference)
    }
    const result = this.mutationQueue.then(async () => {
      const removed = await this.repository.removeResourceAssignments(resources)
      for (const reference of resources) {
        this.pendingResourceDeletions.delete(this.resourceKey(reference))
      }
      if (removed === 0) return
      this.revision += 1
      this.events.publish('tags:changed', { revision: this.revision })
    })
    this.mutationQueue = result.catch(() => undefined)
    try {
      await result
    } catch (error) {
      this.revision += 1
      this.events.publish('tags:changed', { revision: this.revision })
      throw error
    }
  }

  private resourceKey(reference: TagResourceRef): string {
    return `${reference.resourceType}:${reference.resourceId}`
  }
}

export { TagService }
