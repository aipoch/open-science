// Minimal shape of i18next's t() so the pure workspace helpers stay importable without an i18n
// instance. It lives in its own module because both workspace-conversation-items and
// workspace-tool-activity-details need it, and the former already imports the latter.
type TranslateClause = (key: string, options?: Record<string, unknown>) => string

// Mirrors i18next resolving these keys against a locale that has no catalog — which is exactly what
// English is here. The singular arrives as defaultValue_one, per the repo's plural convention.
const identityTranslate: TranslateClause = (key, options) => {
  const template =
    options?.count === 1 && typeof options.defaultValue_one === 'string'
      ? options.defaultValue_one
      : key

  return template.replace(/\{\{(\w+)\}\}/gu, (_match, name: string) =>
    String(options?.[name] ?? '')
  )
}

export { identityTranslate }
export type { TranslateClause }
