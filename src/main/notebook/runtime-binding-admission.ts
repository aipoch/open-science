// Host-only per-request prompt policy. Symbols cannot arrive over RPC JSON; the enumerable marker
// survives internal request spreads without adding a wire field or persisted Session preference.
const TRUSTED_BINDING_PERMISSION_PROMPTS = Symbol('trusted-notebook-binding-permission-prompts')
type TrustedBindingRequest = { [TRUSTED_BINDING_PERMISSION_PROMPTS]?: 'none' }

export function markTrustedNotebookBindingPermissionPrompts<T extends object>(
  request: T,
  permissionPrompts: 'none' | undefined
): T {
  if (permissionPrompts === 'none') {
    Object.assign(request, { [TRUSTED_BINDING_PERMISSION_PROMPTS]: permissionPrompts })
  }
  return request
}

export function readTrustedNotebookBindingPermissionPrompts(request: object): 'none' | undefined {
  return (request as TrustedBindingRequest)[TRUSTED_BINDING_PERMISSION_PROMPTS]
}
