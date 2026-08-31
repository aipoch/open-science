import type { PackageMirror } from '../../shared/mirror'
import type { SetPackageMirrorRequest } from '../../shared/settings'

type PackageMirrorStore = Readonly<{
  getSettings: () => Promise<{ packageMirror?: PackageMirror }>
  setPackageMirror: (settings: PackageMirror) => Promise<{ packageMirror?: PackageMirror }>
}>

type PackageMirrorSettingsOwnerOptions = Readonly<{
  repository: PackageMirrorStore
  validate: (settings: SetPackageMirrorRequest) => Promise<void>
  apply: (settings: PackageMirror) => Promise<void>
}>

const cloneMirror = (mirror: PackageMirror | undefined): PackageMirror => ({ ...mirror })

class PackageMirrorSettingsOwner {
  private writeTail: Promise<void> = Promise.resolve()

  constructor(private readonly options: PackageMirrorSettingsOwnerOptions) {}

  set(request: SetPackageMirrorRequest): Promise<PackageMirror> {
    const operation = this.writeTail.then(() => this.commit(request))
    this.writeTail = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  private async commit(request: SetPackageMirrorRequest): Promise<PackageMirror> {
    await this.options.validate(request)
    const previous = cloneMirror((await this.options.repository.getSettings()).packageMirror)
    const stored = await this.options.repository.setPackageMirror(request)
    const packageMirror = cloneMirror(stored.packageMirror)
    try {
      await this.options.apply(packageMirror)
    } catch (error) {
      const rollbackErrors: unknown[] = []
      try {
        await this.options.repository.setPackageMirror(previous)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
      try {
        await this.options.apply(previous)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          'Could not apply or restore the package mirror configuration.'
        )
      }
      throw error
    }
    return packageMirror
  }
}

export { PackageMirrorSettingsOwner }
