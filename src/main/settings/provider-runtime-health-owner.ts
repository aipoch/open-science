import { tryDecryptKey } from './crypto'
import type { SettingsRepository } from './repository'
import type { ProviderRuntimeTarget } from './provider-accounts'
import type { ProviderFailureObservation } from './provider-failure-observation'

export class ProviderRuntimeHealthOwner {
  constructor(
    private readonly repository: SettingsRepository,
    private readonly onChanged?: () => Promise<void>
  ) {}
  async observe(target: ProviderRuntimeTarget, failure: ProviderFailureObservation): Promise<void> {
    const applied = await this.repository.updateProviderValidationIfTargetMatches(
      target.providerId,
      (current) =>
        // A model-specific failure cannot restore an account already known to be unusable.
        !(
          failure.category === 'model-not-found' &&
          current.lastValidationFailure?.category === 'auth' &&
          current.lastValidationFailure.target === undefined
        ) &&
        current.type === target.providerType &&
        (current.configRevision ?? 0) === target.configRevision &&
        tryDecryptKey(current.keyRef) === target.provider.key &&
        // Discard requests that began before the latest explicit successful validation.
        // Failure timestamps cannot guard this: concurrent model failures must accumulate.
        (current.lastValidatedAt ?? 0) < failure.startedAt,
      { ok: false, category: failure.category, status: failure.status },
      failure.category === 'auth' ? undefined : { model: failure.model, endpoint: failure.endpoint }
    )
    if (applied) await this.onChanged?.()
  }
}
