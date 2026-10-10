import { randomUUID } from 'node:crypto'
import { renameSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  researchExecutionBindingSchema,
  researchEnvironmentVariableSchema,
  saveResearchExecutionProfileRequestSchema,
  type ResearchExecutionBinding,
  type ResearchExecutionProfileView,
  type ResearchExecutionSecretSlot
} from '../../shared/research-execution-profile'
import { decryptKey, encryptKey } from '../settings/crypto'
import { assertCredentialAccessAllowed } from '../credential-identity/runtime'
import { readDurableJsonFile, writeDurableJsonFile } from '../storage/durable-json-file'
import {
  storedResearchExecutionProfileSchema as storedProfileSchema,
  researchExecutionProfileDocumentSchema as documentSchema
} from './document'
type StoredProfile = z.infer<typeof storedProfileSchema>
const bindingOf = (profile: StoredProfile): ResearchExecutionBinding =>
  researchExecutionBindingSchema.parse({
    projectId: profile.projectId,
    sourceSessionId: profile.sourceSessionId,
    sourceIdentity: profile.sourceIdentity,
    descriptorVersionId: profile.descriptorVersionId,
    descriptorSha256: profile.descriptorSha256,
    planKey: profile.planKey
  })
const matches = (profile: StoredProfile, binding: ResearchExecutionBinding): boolean =>
  Object.entries(binding).every(([key, value]) => profile[key as keyof StoredProfile] === value)
const view = (profile: StoredProfile): ResearchExecutionProfileView => ({
  profileId: profile.profileId,
  binding: bindingOf(profile),
  displayName: profile.displayName,
  variables: { ...profile.variables },
  allowedNetworkHosts: [...profile.allowedNetworkHosts],
  conditionChanges: [...profile.conditionChanges],
  configuredCredentialKeys: Object.keys(profile.credentialRefs),
  updatedAt: profile.updatedAt
})
/** Main-only, ephemeral credential lease. Never return or stringify it in an Agent/renderer reply. */
export type ResearchExecutionCredentialLease = {
  profile: ResearchExecutionProfileView
  privateEnvironment: Readonly<Record<string, string>>
  secretValues: readonly string[]
  release(): void
}
export class ResearchExecutionProfileStore {
  private readonly path: string
  private pending = Promise.resolve()
  constructor(
    configRoot: string,
    private readonly cipher = { encrypt: encryptKey, decrypt: decryptKey }
  ) {
    this.path = join(configRoot, 'research-execution-profiles.json')
  }
  private async read(): Promise<z.infer<typeof documentSchema>> {
    assertCredentialAccessAllowed()
    const read = await readDurableJsonFile(
      this.path,
      (text) => documentSchema.parse(JSON.parse(text)),
      {
        rename: async (source, destination) => {
          assertCredentialAccessAllowed()
          renameSync(source, destination)
        }
      },
      { maxBytes: 8 * 1024 * 1024 }
    )
    assertCredentialAccessAllowed()
    return read.status === 'found' ? read.value : { version: 1, profiles: [] }
  }
  private async write(
    document: z.infer<typeof documentSchema>,
    signal?: AbortSignal
  ): Promise<void> {
    assertCredentialAccessAllowed()
    signal?.throwIfAborted()
    const encoded = JSON.stringify(document)
    if (Buffer.byteLength(encoded) > 8 * 1024 * 1024)
      throw new Error('Research profile storage capacity reached.')
    await writeDurableJsonFile(this.path, encoded, {
      rename: async (source, destination) => {
        // Match the existing credential stores: no await between the final recovery check and
        // replacement, including a lock/failure which happened during durable temp-file writes.
        assertCredentialAccessAllowed()
        signal?.throwIfAborted()
        renameSync(source, destination)
      }
    })
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.pending.then(operation, operation)
    this.pending = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
  async list(binding: ResearchExecutionBinding): Promise<ResearchExecutionProfileView[]> {
    return (await this.read()).profiles.filter((profile) => matches(profile, binding)).map(view)
  }
  async save(
    value: unknown,
    binding: ResearchExecutionBinding,
    slots: readonly ResearchExecutionSecretSlot[],
    signal?: AbortSignal
  ): Promise<ResearchExecutionProfileView> {
    const request = saveResearchExecutionProfileRequestSchema.parse(value)
    if (
      !Object.entries(binding).every(
        ([key, value]) => request[key as keyof typeof request] === value
      )
    )
      throw new Error('The research profile no longer matches the selected materials.')
    for (const slot of slots)
      if (!researchEnvironmentVariableSchema.safeParse(slot.environmentVariable).success)
        throw new Error(
          'A research credential slot attempts to override a runtime control variable.'
        )
    const slotKeys = new Set(slots.map((slot) => slot.key))
    const slotVariables = new Set(slots.map((slot) => slot.environmentVariable))
    if (
      Object.keys(request.credentials).some((key) => !slotKeys.has(key)) ||
      Object.keys(request.variables).some((key) => slotVariables.has(key))
    )
      throw new Error('Credentials must use the declared credential slots.')
    return this.exclusive(async () => {
      const document = await this.read()
      const previous = request.profileId
        ? document.profiles.find((profile) => profile.profileId === request.profileId)
        : undefined
      if (request.profileId && (!previous || !matches(previous, binding)))
        throw new Error('Research profile not found for this research.')
      if (!previous && document.profiles.length >= 128)
        throw new Error('Research profile capacity reached.')
      const credentialRefs = { ...previous?.credentialRefs }
      for (const [key, secret] of Object.entries(request.credentials))
        credentialRefs[key] = this.cipher.encrypt(secret)
      // Non-secret settings may never contain a configured secret, including a previous value.
      const secrets = Object.values(credentialRefs).map((ref) => this.cipher.decrypt(ref))
      const publicText = JSON.stringify([
        request.displayName,
        request.variables,
        request.allowedNetworkHosts,
        request.conditionChanges
      ])
      if (secrets.some((secret) => publicText.includes(secret)))
        throw new Error('A credential cannot be saved in public research settings.')
      const settings = {
        ...binding,
        displayName: request.displayName,
        variables: request.variables,
        allowedNetworkHosts: request.allowedNetworkHosts,
        conditionChanges: request.conditionChanges
      }
      const profile = storedProfileSchema.parse({
        ...settings,
        profileId: previous?.profileId ?? randomUUID(),
        credentialRefs,
        updatedAt: Date.now()
      })
      document.profiles = [
        ...document.profiles.filter((item) => item.profileId !== profile.profileId),
        profile
      ]
      await this.write(document, signal)
      return view(profile)
    })
  }
  async remove(
    profileId: string,
    binding: ResearchExecutionBinding,
    signal?: AbortSignal
  ): Promise<void> {
    await this.exclusive(async () => {
      const document = await this.read()
      document.profiles = document.profiles.filter(
        (profile) => profile.profileId !== profileId || !matches(profile, binding)
      )
      await this.write(document, signal)
    })
  }
  async lease(
    profileId: string,
    binding: ResearchExecutionBinding,
    slots: readonly ResearchExecutionSecretSlot[]
  ): Promise<ResearchExecutionCredentialLease> {
    const profile = (await this.read()).profiles.find(
      (item) => item.profileId === profileId && matches(item, binding)
    )
    if (!profile)
      throw new Error('The research execution profile is unavailable for these materials.')
    for (const slot of slots)
      if (!researchEnvironmentVariableSchema.safeParse(slot.environmentVariable).success)
        throw new Error(
          'A research credential slot attempts to override a runtime control variable.'
        )
    const privateEnvironment: Record<string, string> = { ...profile.variables }
    const secretValues: string[] = []
    for (const slot of slots) {
      const ref = profile.credentialRefs[slot.key]
      if (!ref) {
        if (slot.required)
          throw new Error('A required research credential has not been configured.')
        continue
      }
      let secret: string
      try {
        secret = this.cipher.decrypt(ref)
        if (!secret || secret.includes('\0')) throw new Error('Invalid research credential')
      } catch {
        throw new Error(
          'A research credential is unavailable. Unlock local credential storage and retry.'
        )
      }
      privateEnvironment[slot.environmentVariable] = secret
      secretValues.push(secret)
    }
    return {
      profile: view(profile),
      privateEnvironment,
      secretValues,
      release: () => {
        for (const key of Object.keys(privateEnvironment)) delete privateEnvironment[key]
        secretValues.fill('')
        secretValues.length = 0
      }
    }
  }
}
