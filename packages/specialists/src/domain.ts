import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { SpecialistPackageRecoveryError } from './package/transaction'
import { SpecialistRepository } from './repository'
import { SpecialistService, type SpecialistPolicy } from './service'
import { SpecialistPackageService, type SpecialistPackageServiceOptions } from './package/service'
import type { SpecialistLogger } from './ports'
import type { BuiltinSpecialistRegistryResult } from './archive-contracts'

export type SpecialistCatalog = Pick<SpecialistService, keyof SpecialistService>
export type SpecialistArchives = Pick<SpecialistPackageService, keyof SpecialistPackageService>
export type SpecialistArchiveOptions = Omit<
  SpecialistPackageServiceOptions,
  'repository' | 'storageDir'
>
export type SpecialistDomainOptions = {
  storageDir: string
  logger?: SpecialistLogger
  builtinRegistry?: { load(): Promise<BuiltinSpecialistRegistryResult> }
  policy?: SpecialistPolicy
}
export type SpecialistDomain = {
  catalog: SpecialistCatalog
  withReadLock<T>(operation: () => Promise<T>): Promise<T>
  createArchives(options: SpecialistArchiveOptions): SpecialistArchives
}

/** One writable repository and archive transaction owner per composed domain. */
export function createSpecialistDomain(options: SpecialistDomainOptions): SpecialistDomain {
  const repository = new SpecialistRepository(options.storageDir, options.logger)
  let archives: SpecialistPackageService | undefined
  const recovery = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (archives) return archives.withRecoveryBarrier(operation)
    try {
      await access(join(options.storageDir, 'specialist-package-transaction.json'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return operation()
      throw new SpecialistPackageRecoveryError()
    }
    throw new SpecialistPackageRecoveryError()
  }
  const catalog = new SpecialistService(
    repository,
    options.builtinRegistry,
    recovery,
    options.policy,
    options.logger
  )
  return {
    catalog,
    withReadLock: (operation) => repository.withReadLock(operation),
    createArchives(archiveOptions) {
      if (archives)
        throw new Error('Specialist archives have already been composed for this domain.')
      archives = new SpecialistPackageService({
        ...archiveOptions,
        storageDir: options.storageDir,
        repository
      })
      return archives
    }
  }
}
