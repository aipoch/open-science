// Catalog guards. These run on every `npm run test`, so a PR that drops a placeholder, mixes scripts,
// or leaves a translation stranded fails before review.
//
// Keys are the English source text and English has no catalog, so there is no en/zh key-set parity to
// check — English cannot go missing. What replaces it is the orphan guard at the bottom: editing an
// English string silently changes its key, and the old translation would keep sitting in the catalog
// resolving to nothing. That is the one failure mode natural-language keys add, and it is the reason
// this file grew a source scan.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import i18next from 'i18next'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider, Trans } from 'react-i18next'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import zhHans from '../locales/zh-Hans.json'
import zhHant from '../locales/zh-Hant.json'
import {
  englishSourceFallbackPostProcessor,
  hasValidTagStructure,
  sanitizeCatalog
} from './resources'

type Catalog = Record<string, string>

const sourceCatalogs = {
  'zh-Hans': zhHans,
  'zh-Hant': zhHant
} as const

type TranslatedLocale = keyof typeof sourceCatalogs

const TRANSLATED = Object.keys(sourceCatalogs) as TranslatedLocale[]

const catalog = (locale: TranslatedLocale): Catalog => sourceCatalogs[locale] as Catalog

const rawCatalog = (locale: TranslatedLocale): string =>
  readFileSync(join(__dirname, '..', 'locales', `${locale}.json`), 'utf8')

const rawCatalogKeys = (source: string): string[] =>
  [...source.matchAll(/^\s*"((?:[^"\\]|\\.)+)"\s*:/gm)].map((match) => JSON.parse(`"${match[1]}"`))

// {{name}} interpolation placeholders and <tag> markers consumed by the Trans component. Both must
// survive translation: a dropped placeholder renders a blank where a value belongs, and a dropped tag
// makes Trans throw away the wrapped element.
const markers = (text: string): string[] =>
  [...text.matchAll(/\{\{(\w+)\}\}|<(\/?\w+)>/g)].map((match) => match[0]).sort()

// i18next resolves plurals and contexts by suffixing the key with `_other`, `_ago`, and so on. No
// English source string contains an underscore (asserted below), so the first underscore is always
// the boundary between the English text and i18next's suffixes.
const englishOf = (key: string): string => key.split('_')[0]

const PLURAL_CATEGORIES = new Set(['zero', 'one', 'two', 'few', 'many', 'other'])
// This key is selected by a lookup table whose caller always supplies count=0, even though the copy
// itself has no interpolation marker. Keep the exceptional contract explicit; every other counted
// key is discovered by its {{count}} marker below.
const COUNTED_KEYS_WITHOUT_MARKER = ['probed just now'] as const

describe('runtime catalog fallback', () => {
  it('keeps valid translations without copying the catalog', () => {
    const valid = {
      'Hello {{name}}': '你好，{{name}}',
      'Open <docsLink>the guide</docsLink>': '打开 <docsLink>指南</docsLink>'
    }

    expect(sanitizeCatalog(valid)).toBe(valid)
  })

  it('replaces invalid translations with the English source text', () => {
    const invalid: Record<string, unknown> = {
      Empty: '   ',
      'Wrong type': null,
      'Hello {{name}}': '你好',
      'Hello there': '你好 {{name}}',
      'Open <docsLink>the guide</docsLink>': '打开指南',
      Archive_verb: '',
      '{{count}} files_other': '{{total}} 个文件',
      '{{count}}d_ago_other': '{{total}} 天前'
    }

    expect(sanitizeCatalog(invalid)).toEqual({
      Empty: 'Empty',
      'Wrong type': 'Wrong type',
      'Hello {{name}}': 'Hello {{name}}',
      'Hello there': 'Hello there',
      'Open <docsLink>the guide</docsLink>': 'Open <docsLink>the guide</docsLink>',
      Archive_verb: 'Archive',
      '{{count}} files_other': '{{count}} files',
      '{{count}}d_ago_other': '{{count}}d'
    })
    expect(invalid.Archive_verb).toBe('')
  })

  it('rejects crossed or unbalanced Trans tags even when the marker sets match', () => {
    const key = 'Open <outer><inner>the guide</inner></outer>'
    expect(hasValidTagStructure('<outer><inner>打开指南</outer></inner>')).toBe(false)

    expect(
      sanitizeCatalog({
        [key]: '<outer><inner>打开指南</outer></inner>'
      })
    ).toEqual({ [key]: key })
  })

  it('renders sanitized context, plural, and Trans values as usable English', async () => {
    const richKey = 'Open <outer><inner>the guide</inner></outer>'
    const instance = i18next.createInstance()
    instance.use(englishSourceFallbackPostProcessor)
    await instance.init({
      lng: 'zh-Hans',
      fallbackLng: 'en',
      supportedLngs: ['en', 'zh-Hans'],
      keySeparator: false,
      nsSeparator: false,
      interpolation: { escapeValue: false },
      postProcess: [englishSourceFallbackPostProcessor.name],
      resources: {
        'zh-Hans': {
          translation: sanitizeCatalog({
            Archive: '压缩包',
            Archive_verb: '',
            '{{count}} files_other': '{{total}} 个文件',
            '{{count}}d_ago_other': '{{total}} 天前',
            [richKey]: '<outer><inner>打开指南</outer></inner>'
          })
        }
      }
    })

    expect(instance.t('Archive', { context: 'verb' })).toBe('Archive')
    expect(instance.t('{{count}} files', { count: 1, defaultValue_one: '{{count}} file' })).toBe(
      '1 file'
    )
    expect(instance.t('{{count}} files', { count: 2, defaultValue_one: '{{count}} file' })).toBe(
      '2 files'
    )
    expect(instance.t('{{count}}d', { count: 3, context: 'ago' })).toBe('3d')

    const html = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n: instance },
        createElement(Trans, {
          i18nKey: richKey,
          components: {
            outer: createElement('strong'),
            inner: createElement('a', { href: '/guide' })
          }
        })
      )
    )
    expect(html).toContain('<a href="/guide">the guide</a>')
  })
})

describe.each(TRANSLATED)('%s catalog', (locale) => {
  it('has no duplicate raw JSON keys', () => {
    const seen = new Set<string>()
    const duplicates = rawCatalogKeys(rawCatalog(locale)).filter((key) => {
      if (seen.has(key)) return true
      seen.add(key)
      return false
    })

    expect(duplicates).toEqual([])
  })

  it('has no empty strings', () => {
    const empty = Object.entries(catalog(locale))
      .filter(([, value]) => typeof value !== 'string' || value.trim().length === 0)
      .map(([key]) => key)

    expect(empty).toEqual([])
  })

  // The key *is* the English source, so this compares a translation against its own original with no
  // second catalog to consult.
  it('preserves every placeholder and tag from the English key', () => {
    const mismatched = Object.entries(catalog(locale))
      .filter(([key, value]) => markers(englishOf(key)).join('|') !== markers(value).join('|'))
      .map(([key]) => key)

    expect(mismatched).toEqual([])
  })

  it('uses balanced, properly nested non-void Trans tags', () => {
    const malformed = Object.entries(catalog(locale))
      .filter(
        ([key, value]) => !hasValidTagStructure(englishOf(key)) || !hasValidTagStructure(value)
      )
      .map(([key]) => key)

    expect(malformed).toEqual([])
  })

  // Chinese has a single plural category, so a `_one` entry is copy that can never render. English
  // needs no catalog entry at all: the key carries the plural form and the call site passes the
  // singular as `defaultValue_one`.
  it('uses only the plural categories Chinese grammar has', () => {
    const wrong = Object.keys(catalog(locale))
      .map((key) => ({ key, suffix: key.split('_').at(-1) ?? '' }))
      .filter(({ suffix }) => PLURAL_CATEGORIES.has(suffix) && suffix !== 'other')
      .map(({ key }) => key)

    expect(wrong).toEqual([])
  })

  it('stores every counted translation under the Chinese _other category', () => {
    const bareCountedKeys = Object.keys(catalog(locale)).filter(
      (key) => englishOf(key).includes('{{count}}') && !key.endsWith('_other')
    )

    expect(bareCountedKeys).toEqual([])
  })

  it('suffixes dynamic counted keys that have no interpolation marker', () => {
    const entries = catalog(locale)
    const invalid = COUNTED_KEYS_WITHOUT_MARKER.filter(
      (key) => entries[key] !== undefined || entries[`${key}_other`] === undefined
    )

    expect(invalid).toEqual([])
  })
})

describe('dynamic counted lookup translations', () => {
  it.each([
    {
      locale: 'zh-Hans' as const,
      expected: ['刚刚探测', '3 小时前探测', '3 天前', '3 天前']
    },
    {
      locale: 'zh-Hant' as const,
      expected: ['剛剛探測', '3 小時前探測', '3 天前', '3 天前']
    }
  ])('resolves $locale lookup-table keys through _other', async ({ locale, expected }) => {
    const instance = i18next.createInstance()
    await instance.init({
      lng: locale,
      fallbackLng: 'en',
      keySeparator: false,
      nsSeparator: false,
      interpolation: { escapeValue: false },
      resources: { [locale]: { translation: catalog(locale) } }
    })

    expect([
      instance.t('probed just now', { count: 0 }),
      instance.t('probed {{count}} h ago', { count: 3 }),
      instance.t('{{count}}d ago', { count: 3 }),
      instance.t('{{count}} days ago', { count: 3 })
    ]).toEqual(expected)
  })
})

describe('mandatory product glossary', () => {
  const glossary = [
    { term: 'Agent', source: /\b(?:sub)?agents?\b/i, ignore: /ssh-agent/i },
    { term: 'Notebook', source: /\bnotebooks?\b/i },
    { term: 'Skill', source: /\bskills?\b/i, ignore: /(?:\.skill|SKILL\.md|skill:\/\/)/ }
  ]

  it.each(TRANSLATED)('%s keeps branded terms in English', (locale) => {
    const offenders = Object.entries(catalog(locale)).flatMap(([key, value]) => {
      const source = englishOf(key).replace(/\{\{\w+\}\}/g, '')
      return glossary
        .filter(({ term, source: pattern, ignore }) => {
          return pattern.test(source) && !ignore?.test(source) && !value.includes(term)
        })
        .map(({ term }) => `${key}: ${term}`)
    })

    expect(offenders).toEqual([])
  })
})

// The suffix convention above is only unambiguous while no English string contains an underscore.
// If a future string does, englishOf() would truncate it and every guard here would quietly compare
// the wrong text, so this is asserted rather than assumed.
describe('key shape', () => {
  it.each(TRANSLATED)('%s keys carry no underscore inside the English text', (locale) => {
    // i18next's plural and context suffixes used by literal call sites. Each new context has to be
    // listed deliberately so an underscore in source copy cannot be mistaken for resolver syntax.
    const suffixes = new Set([
      ...PLURAL_CATEGORIES,
      'verb',
      'step',
      'files',
      'ago',
      'duration',
      'inUse'
    ])
    const offenders = Object.keys(catalog(locale))
      .filter((key) => key.includes('_'))
      .filter((key) =>
        key
          .split('_')
          .slice(1)
          .some((part) => !suffixes.has(part))
      )

    expect(offenders).toEqual([])
  })
})

// Script guards. Traditional copy must not contain simplified-only characters (and vice versa) — the
// signature of a catalog that was produced by running a converter over the other one, or of a
// copy-paste between the two. Character-level rather than term-level on purpose: it catches terms the
// glossary hasn't enumerated yet. Both sets are high-frequency-in-UI subsets, not exhaustive.
const SIMPLIFIED_ONLY = '设网软数据夹缓认项连组织际检验证权应务边浅业开关闭结'
const TRADITIONAL_ONLY = '設網軟數據夾緩認項連組織際檢驗證權應務邊淺業開關閉結'

const offendingChars = (text: string, forbidden: string): string[] => [
  ...new Set([...text].filter((char) => forbidden.includes(char)))
]

describe('script purity', () => {
  it('zh-Hant contains no simplified-only characters', () => {
    const offenders = Object.entries(catalog('zh-Hant')).flatMap(([key, value]) =>
      offendingChars(value, SIMPLIFIED_ONLY).map((char) => `${key}: ${char}`)
    )

    expect(offenders).toEqual([])
  })

  it('zh-Hans contains no traditional-only characters', () => {
    const offenders = Object.entries(catalog('zh-Hans')).flatMap(([key, value]) =>
      offendingChars(value, TRADITIONAL_ONLY).map((char) => `${key}: ${char}`)
    )

    expect(offenders).toEqual([])
  })
})

// Trans parses its string with an HTML parser, so a tag named after a void element is self-closed and
// its label escapes the wrapper — e.g. <link>Guide</link> renders an empty <a> followed by bare text,
// producing a link nobody can click. Marker parity can't catch this: key and value carry the same tag.
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr'
])

const voidTagsIn = (text: string): string[] =>
  [...text.matchAll(/<(\w+)>[^<]/g)]
    .filter((match) => VOID_ELEMENTS.has(match[1].toLowerCase()))
    .map((match) => `<${match[1]}>`)

describe('Trans tag names', () => {
  it.each(TRANSLATED)('%s uses no void HTML element as a wrapping tag', (locale) => {
    const offenders = Object.entries(catalog(locale)).flatMap(([key, value]) =>
      [...voidTagsIn(englishOf(key)), ...voidTagsIn(value)].map((tag) => `${key}: ${tag}`)
    )

    expect(offenders).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Orphan guard
// ---------------------------------------------------------------------------

// src/. Both renderer entry trees and src/shared are scanned: shared modules have no i18n access, so
// they carry English copy the renderer resolves through t() (install-source labels, download
// progress). Leaving either shared or renderer/web out makes live keys look orphaned.
const SRC_ROOT = join(__dirname, '../../..')

const SCAN_ROOTS = [
  join(SRC_ROOT, 'renderer', 'src'),
  join(SRC_ROOT, 'renderer', 'web'),
  join(SRC_ROOT, 'shared'),
  join(SRC_ROOT, 'main')
]

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'locales' ? [] : sourceFiles(path)
    if (!/\.tsx?$/.test(entry.name)) return []
    // Tests assert on resolved copy, so a string that survives only in a test is still an orphan.
    if (/\.(test|render\.test)\.tsx?$/.test(entry.name)) return []
    return [path]
  })

const unescape = (raw: string): string =>
  raw.replace(/\\(['"`\\nrt])/g, (_, char: string) =>
    char === 'n' ? '\n' : char === 'r' ? '\r' : char === 't' ? '\t' : char
  )

// Every string literal in the renderer, not only the ones inside a t() call. Keys reach t() through
// module-level lookup tables (COMPACT_ELAPSED, PANEL_NAME_LOWER, …) as often as they appear inline, and
// matching those by pattern would miss them. Over-collecting costs nothing here: a stray non-key
// literal can only mask an orphan, never invent one, and a silent miss beats a flaky guard.
const literalsIn = (source: string): string[] => [
  ...[...source.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)].map((match) => unescape(match[1])),
  ...[...source.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)].map((match) => unescape(match[1])),
  ...[...source.matchAll(/`((?:[^`\\$]|\\.|\$(?!\{))*)`/g)].map((match) => unescape(match[1]))
]

describe('orphaned translations', () => {
  const literals = new Set(
    SCAN_ROOTS.flatMap(sourceFiles).flatMap((path) => literalsIn(readFileSync(path, 'utf8')))
  )

  it.each(TRANSLATED)('every %s key still matches an English string in the source', (locale) => {
    const orphans = Object.keys(catalog(locale)).filter((key) => !literals.has(englishOf(key)))

    expect(orphans).toEqual([])
  })
})

// A key that still looks like the old semantic path means a call site was missed by the migration: it
// renders 'shell.panels.model' on screen instead of copy, and no type error remains to catch it.
// Comments are text like any other to the scan below, and the migration left explanatory comments that
// quote a semantic path as the counter-example — including this file's own header. Dropping whole-line
// comments is enough and cannot hide a leak: a line that is entirely a comment holds no code.
const codeOnly = (source: string): string =>
  source
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line))
    .join('\n')

describe('semantic key leaks', () => {
  const SEMANTIC_PATH = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9-]+){2,}$/

  it('no t() call passes a dotted semantic path', () => {
    const offenders = SCAN_ROOTS.flatMap(sourceFiles).flatMap((path) => {
      const source = codeOnly(readFileSync(path, 'utf8'))
      return [...source.matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)]
        .map((match) => match[1])
        .filter((key) => SEMANTIC_PATH.test(key))
        .map((key) => `${path.slice(SRC_ROOT.length + 1)}: ${key}`)
    })

    expect(offenders).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Missing-translation guard
// ---------------------------------------------------------------------------

// The orphan guard runs catalog → source. This one runs source → catalog, and it exists because that
// direction failed in a way nothing here caught: a call site whose English does not byte-match a
// catalog key resolves to the key, which *is* correct English, so zh readers silently get English
// while every parity check above stays green. Inline literals reaching t() and Trans are both
// checked, as are the branches of a ternary argument; keys that arrive through a lookup table are
// invisible here, and the orphan guard covers those instead.

// Consume one quoted string starting at the opening quote, honouring backslash escapes so an
// apostrophe inside a double-quoted string cannot truncate the literal.
const readStringLiteral = (
  source: string,
  start: number
): { value: string; end: number } | null => {
  const quote = source[start]
  if (quote !== '"' && quote !== "'") return null
  let value = ''
  for (let i = start + 1; i < source.length; i += 1) {
    const char = source[i]
    if (char === '\\') {
      const next = source[i + 1]
      value += next === 'n' ? '\n' : next === 't' ? '\t' : next
      i += 1
      continue
    }
    if (char === quote) return { value, end: i }
    if (char === '\n') return null
    value += char
  }
  return null
}

type CallSite = { key: string; plural: boolean; context: string | null }

// Walks to the end of a call's first argument: the top-level comma, or the closing paren when there
// is only one argument. Nesting and string bodies are skipped so a comma inside an options object or
// a quoted comma cannot end the argument early.
const firstArgumentEnd = (source: string, start: number): number => {
  let depth = 0
  for (let i = start; i < source.length; i += 1) {
    const char = source[i]
    if (char === '"' || char === "'" || char === '`') {
      const literal = readStringLiteral(source, i)
      i = literal ? literal.end : i
      continue
    }
    if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') {
      if (depth === 0) return i
      depth -= 1
    } else if (char === ',' && depth === 0) return i
  }
  return source.length
}

// Every string literal in a ternary first argument, as in t(pinned ? 'Unpin' : 'Pin'). Both branches
// render, so both are keys. Without this the entire call is skipped: the argument does not start with
// a quote, so the literal read fails and the site never reaches the catalog check. That is exactly how
// 'Pin project' shipped resolving to English for zh readers while every guard here stayed green.
const ternaryBranchKeys = (argument: string): string[] => {
  let depth = 0
  let branching = false
  const keys: string[] = []
  for (let i = 0; i < argument.length; i += 1) {
    const char = argument[i]
    if (char === '"' || char === "'") {
      const literal = readStringLiteral(argument, i)
      if (!literal) continue
      keys.push(literal.value)
      i = literal.end
      continue
    }
    if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') depth -= 1
    else if (char === '?' && depth === 0 && argument[i + 1] !== '.') branching = true
  }
  // No top-level `?` means the literals belong to something else (an index, a default). A key that
  // arrives purely through a lookup table stays the orphan guard's job.
  return branching ? keys : []
}

// Skips whitespace so a literal that prettier wrapped onto its own line is still read. Without this
// the scan sees only single-line calls, and a long string — which is exactly the kind prettier
// wraps — escapes the guard entirely.
const skipSpace = (source: string, start: number): number => {
  let i = start
  while (i < source.length && /\s/.test(source[i])) i += 1
  return i
}

// Every `t('…')` / `t("…")`, skipping identifiers that merely end in t (startsWith, format, at).
const tCallSites = (source: string): CallSite[] => {
  const sites: CallSite[] = []
  for (let i = 0; i < source.length - 2; i += 1) {
    if (source[i] !== 't' || source[i + 1] !== '(') continue
    if (/[A-Za-z0-9_$.]/.test(source[i - 1] ?? '')) continue
    const argumentStart = skipSpace(source, i + 2)
    const literal = readStringLiteral(source, argumentStart)
    // A literal first argument ends at its closing quote; a ternary ends at the argument boundary.
    const argumentEnd = literal ? literal.end : firstArgumentEnd(source, argumentStart) - 1
    const keys = literal
      ? [literal.value]
      : ternaryBranchKeys(source.slice(argumentStart, argumentEnd + 1))
    if (keys.length === 0) continue
    // The option object, when there is one, sits between the first argument and the closing paren.
    const tail = source.slice(argumentEnd + 1, argumentEnd + 401)
    const close = tail.indexOf(')')
    const options = close === -1 ? tail : tail.slice(0, close + 1)
    const plural = /\bcount\b/.test(options)
    const context = /\bcontext\s*:\s*['"]([^'"]+)['"]/.exec(options)?.[1] ?? null
    for (const key of keys) sites.push({ key, plural, context })
  }
  return sites
}

// `<Trans i18nKey="…">` resolves through the same catalog but never goes through t(), so the scan
// above cannot see it. These carry the longest copy in the app — the sentences with embedded links —
// which makes them the worst ones to leave unguarded.
const transCallSites = (source: string): CallSite[] =>
  [...source.matchAll(/\bi18nKey\s*=\s*(?=["'])/g)].flatMap((match) => {
    const literal = readStringLiteral(source, match.index + match[0].length)
    if (!literal) return []
    // Trans takes count and context as JSX props rather than object entries, so look ahead to the end
    // of the element. A missed prop can only turn a valid plural into a false positive, never hide a
    // real gap, so an approximate window is the safe direction to err in.
    const tail = source.slice(literal.end + 1, literal.end + 400)
    const element = tail.slice(0, tail.indexOf('>') + 1 || undefined)
    return [
      {
        key: literal.value,
        plural: /\bcount\b/.test(element),
        context: /\bcontext\s*=\s*['"{]\s*['"]?([^'"}\s]+)/.exec(element)?.[1] ?? null
      }
    ]
  })

// A context call must resolve through its exact suffix. Accepting a bare key here hides semantic
// collisions such as noun/verb and duration/runtime, while i18next silently renders the wrong copy.
const resolvesIn = (entries: Catalog, { key, plural, context }: CallSite): boolean => {
  if (context) {
    if (plural) {
      return [...PLURAL_CATEGORIES].some(
        (category) => entries[`${key}_${context}_${category}`] !== undefined
      )
    }
    return entries[`${key}_${context}`] !== undefined
  }
  if (plural) return [...PLURAL_CATEGORIES].some((c) => entries[`${key}_${c}`] !== undefined)
  return entries[key] !== undefined
}

describe('missing translations', () => {
  const sites = SCAN_ROOTS.flatMap(sourceFiles)
    .flatMap((path) => {
      const source = codeOnly(readFileSync(path, 'utf8'))
      return [...tCallSites(source), ...transCallSites(source)].map((site) => ({
        ...site,
        file: path.slice(SRC_ROOT.length + 1)
      }))
    })
    // A literal with no letters at all is a unit or a code, not prose.
    .filter((site) => /[A-Za-z]/.test(site.key))

  // Pins the scan against silently finding nothing — a broken extractor would otherwise report a
  // clean bill of health for the whole app.
  it('finds the call sites to check', () => {
    expect(sites.length).toBeGreaterThan(1000)
  })

  it.each(TRANSLATED)('every English t() literal has a %s translation', (locale) => {
    const entries = catalog(locale)
    const untranslated = sites
      .filter((site) => !resolvesIn(entries, site))
      .map((site) => `${site.file}: ${JSON.stringify(site.key)}`)

    expect(untranslated).toEqual([])
  })
})

// The guard above is only as good as its parsing, and both subtleties are silent when wrong: a
// truncated literal invents a missing key, and a missed option object turns a valid plural into a
// false positive. These pin the cases that actually bit during the migration.
describe('t() call-site extraction', () => {
  it('reads a literal containing an apostrophe whole', () => {
    expect(tCallSites(`t('It\\'s ready')`)).toEqual([
      { key: "It's ready", plural: false, context: null }
    ])
    expect(tCallSites(`t("I'm ready")`)).toEqual([
      { key: "I'm ready", plural: false, context: null }
    ])
  })

  it('ignores identifiers that merely end in t', () => {
    expect(tCallSites(`name.startsWith('py')`)).toEqual([])
    expect(tCallSites(`format('x')`)).toEqual([])
  })

  it('notices count and context options', () => {
    expect(tCallSites(`t('{{count}} file', { count: n })`)).toEqual([
      { key: '{{count}} file', plural: true, context: null }
    ])
    expect(tCallSites(`t('Updated', { context: 'ago' })`)).toEqual([
      { key: 'Updated', plural: false, context: 'ago' }
    ])
  })

  // 'Pin project' shipped rendering English to zh readers because a ternary argument does not start
  // with a quote, so the literal read failed and the call was skipped entirely.
  it('reads both branches of a ternary argument', () => {
    expect(tCallSites(`t(pinned ? 'Unpin project' : 'Pin project')`)).toEqual([
      { key: 'Unpin project', plural: false, context: null },
      { key: 'Pin project', plural: false, context: null }
    ])
  })

  it('reads a nested ternary and keeps the options of a ternary argument', () => {
    expect(tCallSites(`t(a ? 'Needs you' : b ? 'Completed' : 'Running')`)).toEqual([
      { key: 'Needs you', plural: false, context: null },
      { key: 'Completed', plural: false, context: null },
      { key: 'Running', plural: false, context: null }
    ])
    // The option object follows the ternary rather than a closing quote, so the argument boundary is
    // what separates them. Read wrong, this counted key looks like a missing bare key.
    expect(tCallSites(`t(many ? '{{count}} files' : '{{count}} file', { count: n })`)).toEqual([
      { key: '{{count}} files', plural: true, context: null },
      { key: '{{count}} file', plural: true, context: null }
    ])
  })

  // A lookup table reaching t() by identifier is the orphan guard's job. Claiming it here would
  // report the surrounding literals as keys and bury the real gaps in false positives.
  it('ignores a first argument that is not a ternary of literals', () => {
    expect(tCallSites(`t(STATUS_COPY[check.status])`)).toEqual([])
    expect(tCallSites(`t(labelKey, { count })`)).toEqual([])
    expect(tCallSites(`t(value.key, value.params)`)).toEqual([])
  })

  // Long copy is the copy prettier wraps, so a scan that only reads single-line calls misses exactly
  // the strings most worth guarding. Five untranslated strings shipped through this gap.
  it('reads a literal prettier wrapped onto the next line', () => {
    expect(tCallSites(`t(\n  'Ask anything',\n  { shortcut }\n)`)).toEqual([
      { key: 'Ask anything', plural: false, context: null }
    ])
  })

  it('reads a Trans i18nKey, with count and context as JSX props', () => {
    expect(transCallSites(`<Trans i18nKey="Hello <b>you</b>" />`)).toEqual([
      { key: 'Hello <b>you</b>', plural: false, context: null }
    ])
    expect(transCallSites(`<Trans i18nKey="{{count}} file" count={n} />`)).toEqual([
      { key: '{{count}} file', plural: true, context: null }
    ])
  })

  it('ignores a computed Trans key rather than reporting a false gap', () => {
    expect(transCallSites('<Trans i18nKey={isEdit ? a : b} />')).toEqual([])
  })

  it('resolves a counted key through a plural category alone', () => {
    const entries = { '{{count}} file_other': '{{count}} 个文件' }

    expect(resolvesIn(entries, { key: '{{count}} file', plural: true, context: null })).toBe(true)
    expect(resolvesIn(entries, { key: '{{count}} file', plural: false, context: null })).toBe(false)
    expect(
      resolvesIn(
        { '{{count}} file': '{{count}} 个文件' },
        { key: '{{count}} file', plural: true, context: null }
      )
    ).toBe(false)
  })

  it('requires the exact context and plural-context key shapes', () => {
    expect(resolvesIn({ Back: '返回' }, { key: 'Back', plural: false, context: 'step' })).toBe(
      false
    )
    expect(
      resolvesIn({ Back_step: '返回上一步' }, { key: 'Back', plural: false, context: 'step' })
    ).toBe(true)
    expect(
      resolvesIn(
        { '{{count}}d_ago_other': '{{count}} 天前' },
        { key: '{{count}}d', plural: true, context: 'ago' }
      )
    ).toBe(true)
    expect(
      resolvesIn(
        { '{{count}}d_other': '{{count}} 天' },
        { key: '{{count}}d', plural: true, context: 'ago' }
      )
    ).toBe(false)
  })

  it('reports a key the catalog does not have', () => {
    expect(resolvesIn({}, { key: 'Never translated', plural: false, context: null })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Bare copy guard
// ---------------------------------------------------------------------------

// Every guard above reads strings that are *already* inside t() or Trans. A string nobody wrapped is
// therefore invisible to all of them: it renders English in every locale while the whole suite stays
// green. That is not hypothetical — 294 unwrapped strings across 43 files survived this file at full
// strength, because "did you translate what you wrapped" never asks "did you wrap it".
//
// This guard asks the other question. It reads the JSX itself and requires every prose-looking text
// node, and every attribute the user can actually read, to go through t() or Trans.

const blanked = (text: string): string => text.replace(/[^\n]/g, ' ')

// Consume one quoted literal starting at its opening quote. Escapes are honoured so an apostrophe in a
// double-quoted string cannot end it early; only template literals may span lines.
const quotedEnd = (source: string, start: number): number => {
  const quote = source[start]
  for (let i = start + 1; i < source.length; i += 1) {
    const char = source[i]
    if (char === '\\') {
      i += 1
      continue
    }
    if (char === quote) return i
    if (char === '\n' && quote !== '`') return i - 1
  }
  return source.length - 1
}

// All three masks below preserve length, so a reported line number still matches the file on disk.

// Comments are prose too, and a commented-out JSX line looks exactly like a live one to the scan.
const maskComments = (source: string): string => {
  let out = ''
  let i = 0
  while (i < source.length) {
    const pair = source.slice(i, i + 2)
    if (pair === '//' || pair === '/*') {
      const end = pair === '//' ? source.indexOf('\n', i) : source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : pair === '//' ? end : end + 2
      out += blanked(source.slice(i, stop))
      i = stop
      continue
    }
    const char = source[i]
    // Copied verbatim: a // or /* inside a string is not a comment.
    if (char === '"' || char === "'" || char === '`') {
      const end = quotedEnd(source, i)
      if (end > i) {
        out += source.slice(i, end + 1)
        i = end + 1
        continue
      }
    }
    out += char
    i += 1
  }
  return out
}

// Keeps the quotes, blanks the contents. Without this a string that merely *contains* markup — a docs
// snippet, a test fixture — would read as JSX and its innards as bare copy.
const maskStringBodies = (source: string): string => {
  let out = ''
  let i = 0
  while (i < source.length) {
    const char = source[i]
    if (char === '"' || char === "'" || char === '`') {
      const end = quotedEnd(source, i)
      if (end > i) {
        out += char + blanked(source.slice(i + 1, end)) + source[end]
        i = end + 1
        continue
      }
    }
    out += char
    i += 1
  }
  return out
}

// Trans is the one element whose bare children are correct: it reads them as the key. Text inside a
// self-closing <Trans components={{ …<b>label</b>… }} /> is likewise inert — the translation replaces
// it at render, so flagging it would be pure noise. Masking whole Trans elements covers both.
const maskTransElements = (source: string): string => {
  let out = source
  for (;;) {
    const start = out.search(/<Trans[\s/>]/)
    if (start === -1) return out
    let depth = 0
    let end = out.length
    for (let i = start; i < out.length; i += 1) {
      const char = out[i]
      if (char === '{') depth += 1
      else if (char === '}') depth -= 1
      else if (char === '>' && depth === 0) {
        if (out[i - 1] === '/') {
          end = i + 1
        } else {
          const close = out.indexOf('</Trans>', i)
          end = close === -1 ? i + 1 : close + '</Trans>'.length
        }
        break
      }
    }
    out = out.slice(0, start) + blanked(out.slice(start, end)) + out.slice(end)
  }
}

// Is the '>' at this index the end of a JSX tag, rather than an arrow, a comparison, or the tail of a
// generic type argument? Walk back to the matching '<', ignoring anything nested in braces so an
// attribute like onClick={() => a > b} cannot derail it.
const closesJsxTag = (source: string, index: number): boolean => {
  if (source[index - 1] === '=' || source[index + 1] === '=') return false
  let depth = 0
  for (let i = index - 1; i >= 0; i -= 1) {
    const char = source[i]
    if (char === '}') {
      depth += 1
      continue
    }
    if (char === '{') {
      // Reached an unmatched opener: this '>' lives inside an expression, not a tag.
      if (depth === 0) return false
      depth -= 1
      continue
    }
    if (depth > 0) continue
    if (char === '>') return false
    if (char === '<') {
      // A closing tag ends a tag just as an opening one does, and text may follow either.
      if (source[i + 1] === '/') return /[A-Za-z]/.test(source[i + 2] ?? '')
      if (!/[A-Za-z]/.test(source[i + 1] ?? '')) return false
      // useState<Foo> is not a tag; an identifier before '<' gives it away.
      return !/[A-Za-z0-9_$)\]]/.test(source[i - 1] ?? ' ')
    }
  }
  return false
}

// Anything that survives to here is a run of raw characters between a tag and the next tag or
// expression. These stop it being prose: an unbalanced bracket or an operator means the walk above
// landed somewhere that is not a text node after all.
const NOT_TEXT = /[}>();=]|['"`]/

const isProse = (text: string): boolean => {
  if (text.length < 2) return false
  // Needs a real word, which rules out '·', '—', ':' and other bare separators.
  if (!/[A-Za-z]{2}/.test(text)) return false
  // Units and bare measurements: 12px, 1.5 s.
  if (/^\d+(?:\.\d+)?\s*[a-z%]*$/.test(text)) return false
  // A single lowercase token is an identifier or a fragment, not a sentence. Multi-word copy and
  // anything that starts capitalised, numeric or quoted is fair game.
  if (!/^[A-Z0-9“"']/.test(text) && !text.includes(' ')) return false
  return true
}

type BareCopy = { text: string; line: number }

const decodeJsxEntities = (text: string): string =>
  text
    .replaceAll('&apos;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')

const bareJsxAstText = (source: string): BareCopy[] => {
  const sourceFile = ts.createSourceFile(
    'component.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const found: BareCopy[] = []

  const isInsideTrans = (node: ts.Node): boolean => {
    for (let current = node.parent; current; current = current.parent) {
      if (
        (ts.isJsxElement(current) &&
          current.openingElement.tagName.getText(sourceFile) === 'Trans') ||
        (ts.isJsxSelfClosingElement(current) && current.tagName.getText(sourceFile) === 'Trans')
      ) {
        return true
      }
    }
    return false
  }

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node) && !isInsideTrans(node)) {
      const text = decodeJsxEntities(node.text).replace(/\s+/g, ' ').trim()
      if (isProse(text)) {
        found.push({
          text,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
        })
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return found
}

const bareJsxText = (source: string): BareCopy[] => {
  const masked = maskTransElements(maskStringBodies(maskComments(source)))
  const found: BareCopy[] = []
  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] !== '>' || !closesJsxTag(masked, i)) continue
    // Stop at whichever comes first. Stopping at '{' is what catches copy that runs straight into an
    // expression — `Skills you can also delete{' '}` hid from an earlier scan that only looked for
    // the next '<'.
    const nextTag = masked.indexOf('<', i + 1)
    const nextExpression = masked.indexOf('{', i + 1)
    const candidates = [nextTag, nextExpression].filter((at) => at !== -1)
    if (candidates.length === 0) continue
    const raw = masked.slice(i + 1, Math.min(...candidates))
    if (NOT_TEXT.test(raw)) continue
    const text = raw.replace(/\s+/g, ' ').trim()
    if (!isProse(text)) continue
    found.push({ text, line: masked.slice(0, i + 1).split('\n').length })
  }
  return found
}

// Attributes a screen reader or the user reads out loud. Deliberately short: className and data-testid
// are strings too, and a guard that flagged them would be turned off within a day.
const VISIBLE_ATTRIBUTES = [
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'placeholder',
  'alt'
]

const bareAttributeValues = (source: string): BareCopy[] => {
  // String bodies stay readable here: the literal *is* what we are judging.
  const masked = maskComments(source)
  const pattern = new RegExp(
    `\\b(?:${VISIBLE_ATTRIBUTES.join('|')})\\s*=\\s*(?:"([^"\\n]*)"|'([^'\\n]*)')`,
    'g'
  )
  return [...masked.matchAll(pattern)].flatMap((match) => {
    const text = (match[1] ?? match[2] ?? '').replace(/\s+/g, ' ').trim()
    if (!isProse(text)) return []
    return [{ text, line: masked.slice(0, match.index).split('\n').length }]
  })
}

// String literals inside JSX expressions are just as visible as text nodes. In particular,
// conditional labels and template strings were invisible to the original scanner even though they
// are common for loading states and result banners.
const bareJsxExpressionValues = (source: string): BareCopy[] => {
  const sourceFile = ts.createSourceFile(
    'component.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const found: BareCopy[] = []

  const record = (node: ts.Node, text: string): void => {
    const normalized = text.replace(/\s+/g, ' ').trim()
    if (!isProse(normalized)) return
    found.push({
      text: normalized,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
    })
  }

  const inspect = (expression: ts.Expression): void => {
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isNonNullExpression(expression)
    ) {
      inspect(expression.expression)
      return
    }
    if (ts.isConditionalExpression(expression)) {
      inspect(expression.whenTrue)
      inspect(expression.whenFalse)
      return
    }
    if (
      ts.isBinaryExpression(expression) &&
      [
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.AmpersandAmpersandToken
      ].includes(expression.operatorToken.kind)
    ) {
      inspect(expression.left)
      inspect(expression.right)
      return
    }
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      record(expression, expression.text)
      return
    }
    if (ts.isTemplateExpression(expression)) {
      record(
        expression,
        expression.head.text + expression.templateSpans.map((span) => span.literal.text).join('')
      )
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isJsxExpression(node) && node.expression) {
      const parent = node.parent
      const isVisibleAttribute =
        ts.isJsxAttribute(parent) && VISIBLE_ATTRIBUTES.includes(parent.name.getText(sourceFile))
      if (isVisibleAttribute || ts.isJsxElement(parent) || ts.isJsxFragment(parent)) {
        inspect(node.expression)
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return found
}

// Proper nouns, product names and literal keystrokes. These render identically in every locale, so
// wrapping them would add a catalog entry that can only ever be copied verbatim.
const NOT_TRANSLATABLE = new Set([
  'Open Science',
  'Open Science Remote',
  'Remote.It',
  'Discord',
  'GitHub',
  'SKILL.md',
  'openid profile',
  'Python',
  'Enter',
  'Esc',
  'Ctrl',
  'Ctrl+',
  'Enter / Tab',
  // A placeholder showing literal CLI arguments. Translating it would suggest the user should type
  // words instead of flags.
  '-y @modelcontextprotocol/server-memory',
  'KEY=value ANOTHER_KEY=value',
  'Authorization: Bearer <token> X-Api-Key: <key>',
  '# Instructions Step-by-step guidance for the agent…'
])

// `return <Icon />` inside a switch leaves the following `default: return` sitting between a `/>` and
// the next `<`, which reads exactly like a text node to the scan above. Recognising the statement
// keywords is narrower than trying to track JSX nesting, and no user-facing copy starts this way.
const CODE_LOOKALIKE = /^(?:default|case|return|break|const|let|await)\b/

// Known-bare copy, frozen so the guard can fail on anything NEW while the tail is worked down.
//
// Every entry here is one shape the migration's first scanner could not see: prose that runs straight
// into a {expression} sibling, so there is no `>text<` for a text-node match to land on. Wrapping them
// is not a mechanical t() call — the sentence has to be recut around an interpolation or a <Trans>,
// which is a source change per site rather than a catalog addition. They render English today and did
// before this PR, so freezing them holds the line without pretending the work is done.
//
// Shrink this list; never grow it. Deleting the last entry for a file is the goal.
const KNOWN_BARE = new Set<string>()

describe('bare copy', () => {
  const components = SCAN_ROOTS.flatMap(sourceFiles).filter((path) => path.endsWith('.tsx'))

  const offenders = components.flatMap((path) => {
    const source = readFileSync(path, 'utf8')
    const file = path.slice(SRC_ROOT.length + 1)
    return [
      ...bareJsxAstText(source),
      ...bareAttributeValues(source),
      ...bareJsxExpressionValues(source)
    ]
      .filter(({ text }) => !NOT_TRANSLATABLE.has(text) && !CODE_LOOKALIKE.test(text))
      .map(({ text, line }) => ({
        // Line numbers move with unrelated edits, so the baseline keys on file and text only.
        id: `${file}: ${JSON.stringify(text)}`,
        label: `${file}:${line}: ${JSON.stringify(text)}`
      }))
  })

  // Pins the scan against silently finding nothing, the same way the missing-translation guard does.
  it('scans the component tree', () => {
    expect(components.length).toBeGreaterThan(150)
  })

  it('adds no unwrapped user-visible copy', () => {
    const unexpected = offenders
      .filter((offender) => !KNOWN_BARE.has(offender.id))
      .map((offender) => offender.label)

    expect(unexpected).toEqual([])
  })

  // Without this, a fixed site would leave a stale allowance behind and the next bare string at the
  // same text in the same file would slip through as "known".
  it('keeps the frozen list free of entries that are already fixed', () => {
    const live = new Set(offenders.map((offender) => offender.id))

    expect([...KNOWN_BARE].filter((id) => !live.has(id))).toEqual([])
  })
})

// Both halves of this scan fail silently when wrong — a missed text node reports nothing, and an
// over-eager match reports copy that is already handled. These pin the shapes that actually caused
// trouble while the migration ran.
describe('bare copy detection', () => {
  it('finds text in an element', () => {
    expect(bareJsxText('<span>Needs repair</span>')).toEqual([{ text: 'Needs repair', line: 1 }])
  })

  it('finds JSX text containing an entity or semicolon', () => {
    expect(bareJsxAstText('<p>Skills aren&apos;t available; choose another Agent.</p>')).toEqual([
      { text: "Skills aren't available; choose another Agent.", line: 1 }
    ])
  })

  it('finds text that runs into an expression', () => {
    expect(bareJsxText(`<p>Skills you can also delete{' '}</p>`)).toEqual([
      { text: 'Skills you can also delete', line: 1 }
    ])
  })

  it('finds text following a sibling element', () => {
    expect(bareJsxText('<p><b>x</b> for the raw record</p>')).toEqual([
      { text: 'for the raw record', line: 1 }
    ])
  })

  it('accepts copy already inside t()', () => {
    expect(bareJsxText(`<span>{t('Needs repair')}</span>`)).toEqual([])
  })

  it('accepts the children of a Trans, which are its key', () => {
    expect(bareJsxText('<Trans>Description <muted>(optional)</muted></Trans>')).toEqual([])
  })

  it('accepts the inert slot text of a self-closing Trans', () => {
    expect(
      bareJsxText('<Trans i18nKey="see <a>the log</a>" components={{ a: <b>the log</b> }} />')
    ).toEqual([])
  })

  it('ignores a generic type argument that looks like a tag', () => {
    expect(bareJsxText('const [x] = useState<Record<string, number>>({})')).toEqual([])
  })

  it('ignores an arrow and a comparison inside an attribute', () => {
    expect(
      bareJsxText('<Button onClick={() => setCount((n) => n > 1)}>{t("Go")}</Button>')
    ).toEqual([])
  })

  it('ignores markup quoted inside a string', () => {
    expect(bareJsxText(`const sample = '<span>Not real copy</span>'`)).toEqual([])
  })

  it('ignores commented-out markup', () => {
    expect(bareJsxText('// <span>Not real copy</span>')).toEqual([])
    expect(bareJsxText('/* <span>Not real copy</span> */')).toEqual([])
  })

  it('ignores separators, units and lone identifiers', () => {
    expect(bareJsxText('<span> · </span>')).toEqual([])
    expect(bareJsxText('<span>12px</span>')).toEqual([])
    expect(bareJsxText('<span>v</span>')).toEqual([])
  })

  it('finds a bare aria-label but not a className', () => {
    expect(bareAttributeValues('<button aria-label="Dismiss storage warning" />')).toEqual([
      { text: 'Dismiss storage warning', line: 1 }
    ])
    expect(bareAttributeValues('<div className="flex items-center gap-2" />')).toEqual([])
  })

  it('accepts an aria-label already inside t()', () => {
    expect(bareAttributeValues(`<button aria-label={t('Dismiss storage warning')} />`)).toEqual([])
  })

  it('finds bare conditional labels in JSX children and visible attributes', () => {
    expect(
      bareJsxExpressionValues(
        `<><span>{loading ? 'Downloading…' : 'Download'}</span><button aria-label={copied ? 'Copied' : 'Copy path'} /></>`
      )
    ).toEqual([
      { text: 'Downloading…', line: 1 },
      { text: 'Download', line: 1 },
      { text: 'Copied', line: 1 },
      { text: 'Copy path', line: 1 }
    ])
  })

  it('finds bare template copy rendered from a JSX expression', () => {
    expect(bareJsxExpressionValues('<p>{`Saved to Downloads: ${name}`}</p>')).toEqual([
      { text: 'Saved to Downloads:', line: 1 }
    ])
  })

  it('finds fallback copy in JSX nullish and logical expressions', () => {
    expect(
      bareJsxExpressionValues(
        `<><span>{description ?? 'No description'}</span><span>{title || 'Untitled'}</span></>`
      )
    ).toEqual([
      { text: 'No description', line: 1 },
      { text: 'Untitled', line: 1 }
    ])
  })

  it('accepts translated conditional labels', () => {
    expect(
      bareJsxExpressionValues(`<span>{loading ? t('Downloading…') : t('Download')}</span>`)
    ).toEqual([])
  })
})
