import type { LucideIcon } from 'lucide-react'

export type ActionMenuDefinition = {
  labelKey: string
  icon: LucideIcon
  danger?: boolean
}

export type ActionMenuRecipeEntry<ActionId extends string> =
  { kind: 'action'; action: ActionId } | { kind: 'separator' }

export type DynamicValue<Value, Invocation> = Value | ((invocation: Invocation) => Value)

export type ActionMenuBinding<Invocation> = {
  execute: (invocation: Invocation) => void | Promise<void>
  labelKey?: DynamicValue<string, Invocation>
  icon?: DynamicValue<LucideIcon, Invocation>
  danger?: DynamicValue<boolean, Invocation>
  disabled?: DynamicValue<boolean, Invocation>
  hidden?: DynamicValue<boolean, Invocation>
}

export type ActionMenuSpec<ActionId extends string, Invocation> = {
  identityKey: string
  catalog: Record<ActionId, ActionMenuDefinition>
  recipe:
    | readonly ActionMenuRecipeEntry<ActionId>[]
    | ((invocation: Invocation) => readonly ActionMenuRecipeEntry<ActionId>[])
  bindings: Partial<Record<ActionId, ActionMenuBinding<Invocation>>>
}

export type ResolvedActionMenuAction<ActionId extends string = string> = {
  kind: 'action'
  action: ActionId
  labelKey: string
  icon: LucideIcon
  danger: boolean
  disabled: boolean
}

export type ResolvedActionMenuEntry<ActionId extends string = string> =
  ResolvedActionMenuAction<ActionId> | { kind: 'separator' }

const resolveDynamicValue = <Value, Invocation>(
  value: DynamicValue<Value, Invocation> | undefined,
  invocation: Invocation,
  fallback: Value
): Value =>
  value === undefined
    ? fallback
    : typeof value === 'function'
      ? (value as (invocation: Invocation) => Value)(invocation)
      : value

export const resolveActionMenuEntries = <ActionId extends string, Invocation>(
  spec: ActionMenuSpec<ActionId, Invocation>,
  invocation: Invocation
): ResolvedActionMenuEntry<ActionId>[] => {
  const recipe = typeof spec.recipe === 'function' ? spec.recipe(invocation) : spec.recipe
  const resolved: ResolvedActionMenuEntry<ActionId>[] = []

  // Resolve visibility before separators so missing actions cannot leave empty visual groups.
  for (const recipeEntry of recipe) {
    if (recipeEntry.kind === 'separator') {
      if (resolved.length > 0 && resolved.at(-1)?.kind !== 'separator') {
        resolved.push({ kind: 'separator' })
      }
      continue
    }

    const binding = spec.bindings[recipeEntry.action]
    if (!binding || resolveDynamicValue(binding.hidden, invocation, false)) continue

    const definition = spec.catalog[recipeEntry.action]
    resolved.push({
      kind: 'action',
      action: recipeEntry.action,
      labelKey: resolveDynamicValue(binding.labelKey, invocation, definition.labelKey),
      icon: resolveDynamicValue(binding.icon, invocation, definition.icon),
      danger: resolveDynamicValue(binding.danger, invocation, definition.danger ?? false),
      disabled: resolveDynamicValue(binding.disabled, invocation, false)
    })
  }

  if (resolved.at(-1)?.kind === 'separator') resolved.pop()
  return resolved
}
