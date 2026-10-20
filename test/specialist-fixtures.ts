export const fakeSkillParticipant: import('@aipoch/specialists').SpecialistPackageSkillPort = {
  snapshot: async () => [],
  prepare: async () => {},
  beginMutation: async () => {},
  runInMutationContext: async (_id, operation) => operation(),
  endMutation: async () => {},
  prepareDeletion: async () => {},
  commit: async () => {},
  rollback: async () => {},
  recover: async () => {}
}

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostSpecialistDomain } from '../src/main/specialist/service'
import type { StoredSpecialist, StoredSpecialists } from '@aipoch/specialists/node'

/** Seed/read historical disk fixtures. Production mutations use domain.catalog/archives. */
export class SpecialistStorageFixture {
  domain: ReturnType<typeof createHostSpecialistDomain>
  constructor(readonly storageDir: string) {
    this.domain = createHostSpecialistDomain(storageDir)
  }
  restart(): ReturnType<typeof createHostSpecialistDomain> {
    this.domain = createHostSpecialistDomain(this.storageDir)
    return this.domain
  }
  async getAll(): Promise<StoredSpecialists> {
    try {
      return JSON.parse(await readFile(join(this.storageDir, 'specialists.json'), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, specialists: [] }
      throw error
    }
  }
  async replaceAll(document: StoredSpecialists): Promise<void> {
    await mkdir(this.storageDir, { recursive: true })
    await writeFile(join(this.storageDir, 'specialists.json'), JSON.stringify(document))
  }
  async insert(profile: StoredSpecialist): Promise<void> {
    const document = await this.getAll()
    await this.replaceAll({ ...document, specialists: [...document.specialists, profile] })
  }
}
