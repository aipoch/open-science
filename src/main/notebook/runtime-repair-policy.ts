import { realpathSync } from 'node:fs'

import type { NotebookLanguage } from '../../shared/notebook'
import type { RuntimeOperationRecord } from './operation-journal'
import {
  envPrefix,
  managedRepairRegistryKey,
  pythonBin,
  rBin,
  readRepairRequiredReason,
  resolveEnvName,
  type RepairRequiredReason,
  type RepairRequiredRegistryReason
} from './runtime-paths'
import type { NotebookSessionRuntimeBinding } from './session-aggregate'

type RuntimeRepairBinding = Pick<NotebookSessionRuntimeBinding, 'runtimeId' | 'source'>

export type RuntimeRepairRequirement = Readonly<{
  keys: readonly string[]
  required: boolean
  protectedIdentity: boolean
}>

export type RuntimeRecoveryRepairMarker = Readonly<{
  key: string
  reason: RepairRequiredReason
}>

/** Defines durable repair identities without owning repair or Session lifecycle state. */
export class NotebookRuntimeRepairPolicy {
  constructor(private readonly runtimeRoot: string) {}

  registryKeys(
    language: NotebookLanguage,
    environment: string,
    binding?: RuntimeRepairBinding
  ): readonly string[] {
    if (binding?.source === 'external') return [binding.runtimeId]
    const keys = new Set<string>([environment, managedRepairRegistryKey(environment, language)])
    if (binding?.source === 'managed') keys.add(binding.runtimeId)
    const prefix = envPrefix(this.runtimeRoot, environment)
    const interpreter = language === 'r' ? rBin(prefix) : pythonBin(prefix)
    keys.add(interpreter)
    try {
      keys.add(realpathSync(interpreter))
    } catch {
      // The raw path still covers legacy markers before an interpreter is materialized.
    }
    return [...keys]
  }

  requirement(
    language: NotebookLanguage,
    environment: string,
    binding?: RuntimeRepairBinding
  ): RuntimeRepairRequirement {
    return this.requirementFor(this.registryKeys(language, environment, binding), binding)
  }

  bindingRequirement(
    language: NotebookLanguage,
    environment: string,
    binding: RuntimeRepairBinding
  ): RuntimeRepairRequirement {
    const keys =
      binding.source === 'external'
        ? [binding.runtimeId]
        : [environment, managedRepairRegistryKey(environment, language), binding.runtimeId]
    return this.requirementFor([...new Set(keys)], binding)
  }

  private requirementFor(
    keys: readonly string[],
    binding?: RuntimeRepairBinding
  ): RuntimeRepairRequirement {
    const reasons = keys
      .map((key) => readRepairRequiredReason(this.runtimeRoot, key))
      .filter((reason): reason is RepairRequiredRegistryReason => reason !== undefined)
    return {
      keys,
      required: reasons.length > 0,
      // Untyped external markers remain repairable by an authorized reinstall. Managed legacy
      // markers stay fail-closed because they may represent a protected interpreter identity change.
      protectedIdentity: reasons.some(
        (reason) =>
          reason === 'protected-identity-change' ||
          (reason === 'legacy-unknown' && binding?.source !== 'external')
      )
    }
  }

  markerKey(
    language: NotebookLanguage,
    environment: string,
    binding?: RuntimeRepairBinding
  ): string {
    return binding?.source === 'external'
      ? binding.runtimeId
      : managedRepairRegistryKey(environment, language)
  }

  runtimeId(environment: string, binding?: RuntimeRepairBinding): string {
    return binding?.source === 'external' ? binding.runtimeId : environment
  }

  blockKey(
    language: NotebookLanguage,
    environment: string,
    binding?: RuntimeRepairBinding
  ): string {
    return binding?.source === 'external'
      ? `external:${language}:${binding.runtimeId}`
      : `${language === 'r' ? 'r' : 'python'}:${resolveEnvName(language, environment)}`
  }

  recoveryMarker(record: RuntimeOperationRecord): RuntimeRecoveryRepairMarker {
    const reason = record.repairReason ?? 'interrupted-install'
    const language =
      record.phase === 'install-r' ? 'r' : record.phase === 'install-python' ? 'python' : undefined
    const alreadyScoped = /^managed:(?:python|r):/u.test(record.runtimeId)
    const key =
      reason === 'protected-identity-change' || !record.targetPath || !language || alreadyScoped
        ? record.runtimeId
        : managedRepairRegistryKey(record.runtimeId, language)
    return { key, reason }
  }
}
