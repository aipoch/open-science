// Declaration merging for the natural-language-key scheme.
//
// Keys are the English source text, so there is no English catalog to derive a key union from and
// t() necessarily accepts any string. The compile-time key checking that a semantic-key catalog
// provides is not available here; `resources.test.ts` replaces it at test time by matching every
// literal t() argument in the source against the translated catalogs, which catches the failure this
// scheme actually introduces — editing English copy silently orphans its translations.
//
// keySeparator and nsSeparator must be declared false to match the runtime init in ./index.ts.
// Left at their defaults the type layer treats '.' as key nesting and ':' as a namespace prefix,
// which mis-parses every key that is an ordinary English sentence.

import type { DEFAULT_NAMESPACE } from './resources'

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: typeof DEFAULT_NAMESPACE
    keySeparator: false
    nsSeparator: false
    returnNull: false
  }
}
