// The message catalogs, statically imported so they are in the bundle before the first paint. Both
// translated locales ship together: this is a desktop app (and a localhost web build), so there is no
// network cost to amortize, and lazy loading would reintroduce the language flash that reading the
// preference synchronously exists to avoid.
//
// There is no English catalog. Keys ARE the English source text (see i18n/index.ts), so English
// renders from i18next's missing-key fallback, which returns the key and still runs interpolation.
// A translated string that goes missing therefore degrades to correct English rather than to a
// visible key path.

import zhHans from '../locales/zh-Hans.json'
import zhHant from '../locales/zh-Hant.json'

// A single flat namespace. Natural-language keys are globally unique by construction, so there is
// nothing for a namespace split to disambiguate, and callers never have to know which file a string
// lives in.
export const DEFAULT_NAMESPACE = 'translation'

export const resources = {
  'zh-Hans': { [DEFAULT_NAMESPACE]: zhHans },
  'zh-Hant': { [DEFAULT_NAMESPACE]: zhHant }
} as const
