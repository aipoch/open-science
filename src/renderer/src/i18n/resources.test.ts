// Catalog guards. These run on every `npm run test`, so a PR that drops a placeholder, mixes scripts,
// or leaves a translation stranded fails before review.
//
// Keys are the English source text and English has no catalog, so there is no source/catalog key-set
// parity to check — English cannot go missing. What replaces it is the orphan guard at the bottom: editing an
// English string silently changes its key, and the old translation would keep sitting in the catalog
// resolving to nothing. That is the one failure mode natural-language keys add, and it is the reason
// this file grew a source scan.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import i18next from 'i18next'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider, Trans } from 'react-i18next'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import fr from '../locales/fr.json'
import ja from '../locales/ja.json'
import ko from '../locales/ko.json'
import ru from '../locales/ru.json'
import zhHans from '../locales/zh-Hans.json'
import zhHant from '../locales/zh-Hant.json'
import {
  englishSourceFallbackPostProcessor,
  hasValidTagStructure,
  resources,
  sanitizeCatalog
} from './resources'

type Catalog = Record<string, string>

const sourceCatalogs = {
  fr,
  ja,
  ko,
  ru,
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
const REQUIRED_PLURAL_CATEGORIES = {
  fr: ['one', 'many', 'other'],
  ja: ['other'],
  ko: ['other'],
  ru: ['one', 'few', 'many', 'other'],
  'zh-Hans': ['other'],
  'zh-Hant': ['other']
} as const satisfies Record<TranslatedLocale, readonly string[]>

const pluralCategoryOf = (key: string): string | undefined => {
  const suffix = key.split('_').at(-1)
  return suffix && PLURAL_CATEGORIES.has(suffix) ? suffix : undefined
}

const withoutPluralCategory = (key: string): string => {
  const category = pluralCategoryOf(key)
  return category ? key.slice(0, -(category.length + 1)) : key
}
// This key is selected by a lookup table whose caller always supplies count=0, even though the copy
// itself has no interpolation marker. Keep the exceptional contract explicit; every other counted
// key is discovered by its {{count}} marker below.
const COUNTED_KEYS_WITHOUT_MARKER = ['probed just now'] as const

describe('supported catalog registration', () => {
  it('ships every translated catalog in the synchronous first-paint resources', () => {
    expect(Object.keys(resources).sort()).toEqual([...TRANSLATED].sort())
  })
})

describe('runtime catalog fallback', () => {
  it('ships and registers the Russian catalog', () => {
    expect(existsSync(join(__dirname, '..', 'locales', 'ru.json'))).toBe(true)
    expect('ru' in resources).toBe(true)
  })

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

  // Catalogs carry exactly the categories selected by the locale's CLDR rules. English needs no
  // catalog entry at all: the key carries the plural form and the call site passes the singular as
  // `defaultValue_one`.
  it('uses only the plural categories the translated grammar has', () => {
    const allowed = new Set<string>(REQUIRED_PLURAL_CATEGORIES[locale])
    const wrong = Object.keys(catalog(locale))
      .map((key) => ({ key, suffix: pluralCategoryOf(key) }))
      .filter(({ suffix }) => suffix && !allowed.has(suffix))
      .map(({ key }) => key)

    expect(wrong).toEqual([])
  })

  it('stores every counted translation under every category the locale selects', () => {
    const entries = catalog(locale)
    const categories = REQUIRED_PLURAL_CATEGORIES[locale]
    const countedKeys = Object.keys(entries).filter((key) => englishOf(key).includes('{{count}}'))
    const stems = new Set(countedKeys.map(withoutPluralCategory))
    const invalid = countedKeys.filter((key) => {
      const category = pluralCategoryOf(key)
      return !category || !categories.includes(category as never)
    })
    const missing = [...stems].flatMap((stem) =>
      categories.flatMap((category) =>
        entries[`${stem}_${category}`] ? [] : [`${stem}_${category}`]
      )
    )

    expect([...invalid, ...missing]).toEqual([])
  })

  it('provides every plural category selected by the locale at runtime', () => {
    const entries = catalog(locale)
    const pluralGroups = new Set(
      Object.keys(entries)
        .filter((key) => PLURAL_CATEGORIES.has(key.split('_').at(-1) ?? ''))
        .map((key) => key.replace(/_(?:zero|one|two|few|many|other)$/, ''))
    )
    const missing = [...pluralGroups].flatMap((key) =>
      REQUIRED_PLURAL_CATEGORIES[locale]
        .filter((category) => entries[`${key}_${category}`] === undefined)
        .map((category) => `${key}_${category}`)
    )

    expect(missing).toEqual([])
  })

  it('suffixes dynamic counted keys that have no interpolation marker', () => {
    const entries = catalog(locale)
    const invalid = COUNTED_KEYS_WITHOUT_MARKER.flatMap((key) => [
      ...(entries[key] === undefined ? [] : [key]),
      ...REQUIRED_PLURAL_CATEGORIES[locale].flatMap((category) =>
        entries[`${key}_${category}`] === undefined ? [`${key}_${category}`] : []
      )
    ])

    expect(invalid).toEqual([])
  })
})

describe('dynamic counted lookup translations', () => {
  it('renders the French CLDR many category without falling back to English', async () => {
    const instance = i18next.createInstance()
    await instance.init({
      lng: 'fr',
      fallbackLng: 'en',
      keySeparator: false,
      nsSeparator: false,
      interpolation: { escapeValue: false },
      resources: { fr: { translation: catalog('fr') } }
    })

    expect(instance.t('{{count}} files', { count: 1_000_000 })).toBe('1000000 fichiers')
  })

  it.each([
    {
      locale: 'fr' as const,
      expected: ["vérifié à l'instant", 'vérifié il y a 3 h', 'il y a 3 j', 'il y a 3 jours']
    },
    {
      locale: 'zh-Hans' as const,
      expected: ['刚刚探测', '3 小时前探测', '3 天前', '3 天前']
    },
    {
      locale: 'zh-Hant' as const,
      expected: ['剛剛探測', '3 小時前探測', '3 天前', '3 天前']
    },
    {
      locale: 'ja' as const,
      expected: ['たった今確認', '3時間前に確認', '3日前', '3日前']
    },
    {
      locale: 'ko' as const,
      expected: ['방금 확인함', '3시간 전에 확인함', '3일 전', '3일 전']
    },
    {
      locale: 'ru' as const,
      expected: ['проверено только что', 'проверено 3 ч назад', '3 дн. назад', '3 дн. назад']
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

  it('selects Russian one, few, many, and other forms', async () => {
    const instance = i18next.createInstance()
    await instance.init({
      lng: 'ru',
      fallbackLng: 'en',
      keySeparator: false,
      nsSeparator: false,
      interpolation: { escapeValue: false },
      resources: { ru: { translation: catalog('ru') } }
    })

    expect([1, 2, 5, 1.5].map((count) => instance.t('{{count}} files', { count }))).toEqual([
      '1 файл',
      '2 файла',
      '5 файлов',
      '1.5 файла'
    ])

    expect([1, 2, 5, 1.5].map((count) => instance.t('{{count}} agents', { count }))).toEqual([
      '1 агент',
      '2 агента',
      '5 агентов',
      '1.5 агента'
    ])
    expect([1, 2, 5, 1.5].map((count) => instance.t('{{count}} steps', { count }))).toEqual([
      '1 шаг',
      '2 шага',
      '5 шагов',
      '1.5 шага'
    ])
    expect([1, 2, 5, 1.5].map((count) => instance.t('{{count}} jobs', { count }))).toEqual([
      '1 задание',
      '2 задания',
      '5 заданий',
      '1.5 задания'
    ])
    expect([1, 2, 5, 1.5].map((count) => instance.t('{{count}} subagents', { count }))).toEqual([
      '1 субагент',
      '2 субагента',
      '5 субагентов',
      '1.5 субагента'
    ])
  })
})

describe('mandatory product glossary', () => {
  const retainedGlossary = [{ term: 'Notebook', source: /\bnotebooks?\b/i }]

  it.each(TRANSLATED)('%s keeps Notebook in English', (locale) => {
    const offenders = Object.entries(catalog(locale)).flatMap(([key, value]) => {
      const source = englishOf(key).replace(/\{\{\w+\}\}/g, '')
      return retainedGlossary
        .filter(({ term, source: pattern }) => pattern.test(source) && !value.includes(term))
        .map(({ term }) => `${key}: ${term}`)
    })

    expect(offenders).toEqual([])
  })

  it.each(['fr', 'ja', 'ko'] as const)(
    '%s keeps product and technical terms in English',
    (locale) => {
      const retainedProductGlossary = [
        { term: 'Open Science', source: /\bOpen Science\b/ },
        { term: 'Anthropic', source: /\bAnthropic\b/ },
        { term: 'Claude', source: /\bClaude\b/ },
        { term: 'Codex', source: /\bCodex\b/ },
        { term: 'opencode', source: /\bOpenCode\b/ },
        { term: 'MCP', source: /\bMCP\b/ },
        { term: 'ACP', source: /\bACP\b/ },
        { term: 'API', source: /\bAPI\b/ },
        { term: 'CLI', source: /\bCLI\b/ },
        { term: 'SSH', source: /\bSSH\b/ },
        { term: 'ZIP', source: /\bZIP\b/ },
        { term: 'GitHub', source: /\bGitHub\b/ },
        { term: 'Discord', source: /\bDiscord\b/ },
        { term: 'Python', source: /\bPython\b/ },
        { term: 'Jupyter', source: /\bJupyter\b/ },
        { term: 'Office', source: /\bOffice\b/ },
        { term: 'Chromium', source: /\bChromium\b/ }
      ]
      const offenders = Object.entries(catalog(locale)).flatMap(([key, value]) => {
        const source = englishOf(key).replace(/\{\{\w+\}\}/g, '')
        return retainedProductGlossary
          .filter(({ term, source: pattern }) => pattern.test(source) && !value.includes(term))
          .map(({ term }) => `${key}: ${term}`)
      })

      expect(offenders).toEqual([])
    }
  )

  it('keeps reviewed French product and technical names in English', () => {
    const retainedTerms = [
      { term: 'Anthropic', source: /\bAnthropic\b/ },
      { term: 'Claude Code', source: /\bClaude Code\b/ },
      { term: 'Chromium', source: /\bChromium\b/ },
      { term: 'Electron', source: /\bElectron\b/ },
      { term: 'Markdown', source: /\bMarkdown\b/ },
      { term: 'Remote.It', source: /\bRemote\.It\b/ }
    ]
    const offenders = Object.entries(catalog('fr')).flatMap(([key, value]) => {
      const source = englishOf(key)
      return retainedTerms
        .filter(({ term, source: pattern }) => {
          const sourceOccurrences = source.split(term).length - 1
          const translationOccurrences = value.split(term).length - 1
          return pattern.test(source) && translationOccurrences < sourceOccurrences
        })
        .map(({ term }) => `${key}: ${term}`)
    })

    expect(offenders).toEqual([])
  })

  const chosenGenericTerms = {
    fr: {
      Agent: 'Agent',
      'Agent framework': "Framework d'agents",
      'Command line tool': 'Outil en ligne de commande',
      Diagnostics: 'Diagnostics',
      failed: 'échec',
      Skills: 'Compétences',
      Specialist: 'Spécialiste',
      Specialists: 'Spécialistes',
      Marketplace: 'Place de marché',
      Connector: 'Connecteur',
      Main: 'Agent principal',
      Light: 'Clair',
      Resume: 'Reprendre',
      Running: 'En cours',
      running: 'en cours',
      Terminal: 'Terminal',
      Shell: 'Terminal',
      'Token usage': 'Utilisation des jetons',
      'Claude setup token': 'Jeton de configuration Claude',
      'Token: {{masked}}': 'Jeton\u00a0: {{masked}}'
    },
    'zh-Hans': {
      Agent: '智能体',
      'Agent framework': '智能体框架',
      Resume: '继续',
      Skills: '技能',
      Specialist: '专家',
      Specialists: '专家',
      Marketplace: '市场',
      Connector: '连接器',
      Main: '主智能体',
      Light: '浅色',
      Running: '运行中',
      Shell: '命令行',
      'Token usage': '词元用量',
      'Claude setup token': 'Claude 设置令牌',
      'Token: {{masked}}': '令牌：{{masked}}'
    },
    'zh-Hant': {
      Agent: '智能體',
      'Agent framework': '智能體框架',
      Resume: '繼續',
      Skills: '技能',
      Specialist: '專家',
      Specialists: '專家',
      Marketplace: '市集',
      Connector: '連接器',
      Main: '主智能體',
      Light: '淺色',
      Running: '執行中',
      Shell: '命令列',
      'Token usage': '詞元用量',
      'Claude setup token': 'Claude 設定權杖',
      'Token: {{masked}}': '權杖：{{masked}}'
    },
    ja: {
      Agent: 'エージェント',
      'Agent framework': 'エージェントフレームワーク',
      Resume: '再開',
      Skills: 'スキル',
      Specialist: 'スペシャリスト',
      Specialists: 'スペシャリスト',
      Marketplace: 'マーケットプレイス',
      Connector: 'コネクタ',
      Main: 'メインエージェント',
      Light: 'ライト',
      Running: '実行中',
      Shell: 'シェル',
      'Token usage': 'トークン使用量',
      'Claude setup token': 'Claude セットアップトークン',
      'Token: {{masked}}': 'トークン：{{masked}}'
    },
    ko: {
      Agent: '에이전트',
      Skills: '스킬',
      Specialist: '스페셜리스트',
      Specialists: '스페셜리스트',
      Marketplace: '마켓플레이스',
      Connector: '커넥터',
      Main: '메인 에이전트',
      Shell: '셸',
      'Token usage': '토큰 사용량',
      'Claude setup token': 'Claude 설정 토큰',
      'Token: {{masked}}': '토큰: {{masked}}'
    },
    ru: {
      Agent: 'Агент',
      Skills: 'Навыки',
      Specialist: 'Специалист',
      Specialists: 'Специалисты',
      Marketplace: 'Маркетплейс',
      Connector: 'Коннектор',
      Main: 'Главный агент',
      Shell: 'Командная строка',
      'Token usage': 'Использование токенов',
      'Claude setup token': 'Токен настройки Claude',
      'Token: {{masked}}': 'Токен: {{masked}}'
    }
  } satisfies Record<TranslatedLocale, Record<string, string>>

  it.each(TRANSLATED)('%s uses the chosen generic terminology', (locale) => {
    const expected = chosenGenericTerms[locale]
    const actual = Object.fromEntries(
      Object.keys(expected).map((key) => [key, catalog(locale)[key]])
    )

    expect(actual).toEqual(expected)
  })

  it('uses native copy for the provider-controlled default hint', () => {
    expect(
      Object.fromEntries(TRANSLATED.map((locale) => [locale, catalog(locale)['provider default']]))
    ).toEqual({
      fr: 'réglage du fournisseur',
      ja: 'プロバイダー設定を使用',
      ko: '모델 제공업체 설정 사용',
      ru: 'настройка поставщика',
      'zh-Hans': '由服务商决定',
      'zh-Hant': '由服務商決定'
    })
  })

  it('uses the chosen French agent framework term in every sentence', () => {
    const offenders = Object.entries(catalog('fr'))
      .filter(([key]) => /\bagent frameworks?\b/i.test(englishOf(key)))
      .filter(([key, value]) => {
        const expected = /\bagent frameworks\b/i.test(englishOf(key))
          ? /frameworks d'agents/i
          : /framework d'agents/i
        return !expected.test(value)
      })
      .map(([key]) => key)

    expect(offenders).toEqual([])
  })

  it('uses theme meanings for French light and dark copy', () => {
    const offenders = Object.entries(catalog('fr'))
      .filter(([key, value]) => {
        const source = englishOf(key)
        return (
          (/\blight\b/i.test(source) && !/\bclair\b/i.test(value)) ||
          (/\bdark\b/i.test(source) && !/\bsombre\b/i.test(value))
        )
      })
      .map(([key]) => key)

    expect(offenders).toEqual([])
  })

  it('uses unambiguous French safety and operation copy', () => {
    const expected = {
      "Conversations still bound to <name>{{name}}</name> will become <em>unavailable</em> and will <em>not</em> be switched to Main Agent automatically. For each affected conversation you'll explicitly choose a new specialist or Main Agent before it can send again.":
        "Les conversations toujours liées à <name>{{name}}</name> deviendront <em>indisponibles</em> et <em>ne seront pas</em> automatiquement basculées vers l'agent principal. Pour chaque conversation concernée, vous devrez choisir explicitement un nouveau spécialiste ou l'agent principal avant de pouvoir envoyer à nouveau des messages.",
      'The candidate authentication configuration is verified before commit. Session enablement and Permission Grants will be cleared.':
        "La configuration d'authentification proposée est vérifiée avant validation. L'activation des sessions et les autorisations accordées seront supprimées.",
      'Ask before file edits, commands, network, and MCP tools.':
        "Demander une autorisation avant de modifier des fichiers, d'exécuter des commandes, d'accéder au réseau ou d'utiliser des outils MCP.",
      'Allow for this conversation': 'Autoriser pour cette conversation',
      'Allow for this project': 'Autoriser pour ce projet',
      'Allowed this session': 'Autorisé pour cette session',
      'Anthropic approx.': 'Estimation Anthropic',
      'Clear all session grants': 'Révoquer toutes les autorisations de la session',
      'Grant folder…': "Autoriser l'accès à un dossier…",
      'Grant this folder': "Autoriser l'accès à ce dossier",
      'Close Provenance': 'Fermer le panneau de provenance',
      'Go to home': 'Accéder au dossier personnel',
      'Go-to locations': 'Accès rapides',
      Cartoon: 'Ruban',
      'Cartoon requires a protein or nucleic-acid backbone':
        'La représentation en rubans nécessite un squelette protéique ou nucléique',
      'Reset runtime': "Réinitialiser l'environnement d'exécution",
      'Install Specialist': 'Installer le spécialiste',
      'Update Specialist': 'Mettre à jour le spécialiste',
      '<em>Your existing data (~{{size}}) will be moved</em> to the new location — your files come with it, and nothing is left behind in the current folder.':
        '<em>Vos données existantes (~{{size}}) seront déplacées</em> vers le nouvel emplacement — vos fichiers les accompagneront et rien ne restera dans le dossier actuel.',
      "Opening your browser to sign in… Didn't open? Cancel and use a setup token.":
        "Ouverture du navigateur pour vous connecter… Rien ne s'est ouvert\u00a0? Annulez et utilisez un jeton de configuration.",
      "Opening your browser to sign in… finish there and this closes automatically. Didn't open, or prefer a token? Paste one below.":
        "Ouverture du navigateur pour vous connecter… Terminez la connexion dans le navigateur\u00a0; cette fenêtre se fermera automatiquement. Rien ne s'est ouvert, ou vous préférez utiliser un jeton\u00a0? Collez-le ci-dessous.",
      'Its contents fill the editor; switch back to Write to tweak.':
        "Son contenu est chargé dans l'éditeur\u00a0; revenez à Écrire pour le modifier.",
      Image: 'Image',
      'Copy command': 'Copier la commande',
      'Data location': 'Emplacement des données',
      'Edit specialist': 'Modifier le spécialiste',
      'Recent artifacts': 'Artefacts récents',
      'Search sessions and artifacts…': 'Rechercher des sessions et des artefacts…',
      'Search skills': 'Rechercher des compétences',
      'Search skills to add': 'Rechercher des compétences à ajouter',
      'Search skills…': 'Rechercher des compétences…',
      'Search specialists': 'Rechercher des spécialistes',
      'Search specialists…': 'Rechercher des spécialistes…',
      'Specialist delete': 'Suppression du spécialiste',
      'Remote.It is a third-party service. Open Science only calls its user-installed desktop CLI and does not include, redistribute, register, or create an account for it.':
        "Remote.It est un service tiers. Open Science utilise uniquement son interface en ligne de commande (CLI) de bureau installée par l'utilisateur ; il n'inclut pas ce logiciel, ne le redistribue pas, ne l'enregistre pas et ne crée aucun compte pour ce service.",
      'No folders granted yet.': "Aucun accès à un dossier n'a encore été autorisé.",
      "Your home folder itself can't be granted — pick a subfolder.":
        "L'accès ne peut pas être accordé directement au dossier personnel ; choisissez un sous-dossier.",
      'Refreshing…': 'Actualisation…',
      Upload: 'Téléverser',
      'Upload failed': 'Échec du téléversement',
      Runtime: "Environnement d'exécution",
      Runtime_duration: "Durée d'exécution"
    }
    const actual = Object.fromEntries(Object.keys(expected).map((key) => [key, catalog('fr')[key]]))

    expect(actual).toEqual(expected)
  })

  it('uses the chosen French runtime term for environment surfaces', () => {
    // These keys refer to an executable environment, not elapsed time or an individual run.
    const runtimeEnvironmentKeys = [
      'Agent runtime',
      'Agent runtime repair issues',
      "Choose which coding-agent backend drives your sessions. Select a card to switch; switching starts a fresh agent session, and open conversations have their transcript replayed to the new backend. The active runtime can't be uninstalled — switch to the other one first.",
      'Could not change that runtime.',
      'Could not check whether that runtime is in use, so it was not disabled.',
      'Could not load runtimes.',
      'Could not re-check runtimes.',
      'Could not refresh runtime readiness.',
      'Could not reset the runtime.',
      'Detecting runtimes…',
      'Downloading managed runtime…',
      'Downloads a self-contained Codex ACP runtime — no Node.js or npm required.',
      'Manage your agent runtime and model providers.',
      'Managed runtime is not set up yet',
      'Notebook runtime',
      'Notebook runtime (optional)',
      'Notebook runtimes',
      'The selection is saved, but the Agent runtime has not applied it yet. Your draft and queued messages are preserved.',
      'Set up the agent runtime',
      'Setting up the notebook runtime — wait for it to finish, or cancel it, to continue.',
      'Setting up {{language}} runtime',
      'This removes the {{name}} runtime this app downloaded and manages. A separate {{name}} you installed yourself is not affected. You can reinstall it here at any time.',
      '{{label}} runtime',
      'View notebook runtimes?',
      'Change notebook runtime?',
      'Changes the runtime used by the current notebook session.'
    ]
    const offenders = runtimeEnvironmentKeys.filter(
      (key) => !/environnements? d['’]exécution/i.test(catalog('fr')[key])
    )

    expect(offenders).toEqual([])
  })

  it('uses the chosen French Marketplace term throughout the surface', () => {
    const offenders = Object.entries(catalog('fr'))
      .filter(([key]) => /\bMarketplace\b/.test(englishOf(key)))
      .filter(([key]) => !key.includes('Specialist Marketplace protocol'))
      .filter(([, value]) => !/place de marché/i.test(value))
      .map(([key]) => key)

    expect(offenders).toEqual([])
  })

  it('uses the French specialist noun throughout role copy', () => {
    const offenders = Object.entries(catalog('fr'))
      .filter(([key]) => /\bSpecialists?\b/.test(englishOf(key)))
      .filter(([key]) => !key.includes('Specialist Marketplace protocol'))
      .filter(([, value]) => !/\bspécialistes?\b/i.test(value))
      .map(([key]) => key)

    expect(offenders).toEqual([])
  })

  it('uses natural French progress ratios without agreement ambiguity', () => {
    const expected = {
      '{{current}} of {{total}}': '{{current}} sur {{total}}',
      '{{visible}} of {{total}}': '{{visible}} sur {{total}}',
      '{{selected}} of {{total}} selected': 'Sélection : {{selected}}/{{total}}',
      '{{selected}} of {{total}} included': 'Éléments inclus : {{selected}}/{{total}}'
    }
    const actual = Object.fromEntries(Object.keys(expected).map((key) => [key, catalog('fr')[key]]))

    expect(actual).toEqual(expected)
  })

  it('uses an agreement-safe French token coverage ratio for every plural category', () => {
    const expectedValue =
      'Disponibilité des totaux de jetons pour cette période : {{reported}}/{{count}}.'
    const keys = [
      'Token totals are available for {{reported}} of {{count}} runs in this period._one',
      'Token totals are available for {{reported}} of {{count}} runs in this period._other',
      'Token totals are available for {{reported}} of {{count}} runs in this period._many'
    ]

    expect(keys.map((key) => catalog('fr')[key])).toEqual(keys.map(() => expectedValue))
  })

  it('does not use financial terms for French permission grants', () => {
    const offenders = Object.entries(catalog('fr'))
      .filter(([key]) => /\b(?:grants?|granted)\b/i.test(englishOf(key)))
      .filter(([, value]) => /\b(?:subventions?|octrois?)\b/i.test(value))
      .map(([key]) => key)

    expect(offenders).toEqual([])
  })

  it('keeps French high punctuation attached to the preceding text', () => {
    const offenders = Object.entries(catalog('fr'))
      .filter(([, value]) => / [;:?!]/.test(value))
      .map(([key]) => key)

    expect(offenders).toEqual([])
  })

  it('does not use exclamation points in French UI copy', () => {
    const offenders = Object.entries(catalog('fr'))
      .filter(([, value]) => value.includes('!'))
      .map(([key]) => key)

    expect(offenders).toEqual([])
  })

  it('uses téléverser consistently for French upload copy', () => {
    const offenders = Object.entries(catalog('fr'))
      .filter(([key]) => /\bupload(?:ed|ing|s)?\b/i.test(englishOf(key)))
      .filter(([, value]) => !/télévers/i.test(value) || /télécharg/i.test(value))
      .map(([key]) => key)

    expect(offenders).toEqual([])
  })

  it.each(['/path/to/new/location', '/scratch/username', '/path/to/corp-ca-bundle.pem'])(
    'preserves the exact technical path %s in every translated catalog',
    (path) => {
      const offenders = TRANSLATED.filter((locale) => catalog(locale)[path] !== path)

      expect(offenders).toEqual([])
    }
  )

  it.each(TRANSLATED)('%s uses the chosen Shell spelling in every Shell label', (locale) => {
    const expected = {
      fr: /\btermin(?:al|aux)\b/i,
      'zh-Hans': /命令行/,
      'zh-Hant': /命令列/,
      ja: /シェル/,
      ko: /셸/,
      ru: /командн/iu
    }[locale]
    const offenders = Object.entries(catalog(locale))
      .filter(([key]) => /\bshell\b/i.test(englishOf(key)))
      .filter(([, value]) => !expected.test(value))
      .map(([key]) => key)

    expect(offenders).toEqual([])
  })

  it.each(TRANSLATED)(
    '%s uses the chosen Main Agent spelling in every Main role label',
    (locale) => {
      const expected = {
        fr: 'Agent principal',
        'zh-Hans': '主智能体',
        'zh-Hant': '主智能體',
        ja: 'メインエージェント',
        ko: '메인 에이전트',
        ru: 'главн'
      }[locale]
      const offenders = Object.entries(catalog(locale))
        // Main Agent role labels only — a plain "Main model" key is a different concept and
        // must not be forced to carry the agent spelling.
        .filter(([key]) => /\bMain Agent\b/.test(englishOf(key)))
        .filter(([, value]) =>
          locale === 'ru'
            ? !value.toLocaleLowerCase('ru').includes(expected) || !/агент/iu.test(value)
            : !value.toLocaleLowerCase().includes(expected.toLocaleLowerCase())
        )
        .map(([key]) => key)

      expect(offenders).toEqual([])
    }
  )

  const exactTechnicalIdentifierPatterns = [
    /SKILL\.md/g,
    /\b[\w.-]+\.(?:md|txt|json|zip)\b/g,
    /\.(?:md|txt|json|zip|skill|yaml|yml|toml|csv|tsv|ipynb)\b/g,
    /\.skill\b/g,
    /skill:\/\//g,
    /host\.skill\b/g,
    /host\.mcp\("[^"]+", …\)/g,
    /AGENTS\.md/g,
    /ssh-agent/g,
    /setup-token/g,
    /\bopen-science\b/g,
    /\bRemote\.It\b/g,
    /\bZIP\b/g,
    /(?<![:/\w])\/(?:[\w.-]+\/)+[\w.-]*[\w-]/g,
    /\b[A-Za-z]:\\[\w.\\-]*(?<!\.)/g,
    /\bmax_tokens\b/g,
    /\bskills\//g,
    /(?:~\/|\.)[\w./-]*skills\b/g,
    /Specialist Marketplace protocol/g,
    /Claude Connectors Directory/g,
    /<code>[^<]*(?:skills?|agents?)[^<]*<\/code>/gi
  ]
  const additionalRequiredIdentifiers = {
    'The ZIP contains app metadata, the specialist.json you fill in, and a README.txt guide. Skills placed in the skills folder are discovered automatically.':
      ['skills/']
  } satisfies Record<string, string[]>
  const exactTechnicalIdentifiers = (text: string): string[] =>
    exactTechnicalIdentifierPatterns
      .flatMap((identifier) => text.match(identifier) ?? [])
      .sort((left, right) => left.localeCompare(right))
  const withoutTechnicalIdentifiers = (text: string): string =>
    [/\{\{\w+\}\}/g, ...exactTechnicalIdentifierPatterns].reduce(
      (prose, identifier) => prose.replace(identifier, ''),
      text
    )

  it.each(TRANSLATED)('%s preserves exact technical identifiers', (locale) => {
    const offenders = Object.entries(catalog(locale)).flatMap(([key, value]) => {
      const source = englishOf(key)
      const expected = [
        ...exactTechnicalIdentifiers(source),
        ...(additionalRequiredIdentifiers[source] ?? [])
      ].sort((left, right) => left.localeCompare(right))
      const actual = exactTechnicalIdentifiers(value)

      return JSON.stringify(actual) === JSON.stringify(expected)
        ? []
        : [`${key}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`]
    })

    expect(offenders).toEqual([])
  })

  it('ko preserves executable names, API identifiers, code spans, and data directory names', () => {
    const patterns = [
      /\bOpenScience\b/g,
      /\b[\w.-]+\.(?:ps1|sh|mcp)\b/g,
      /<code>[^<]+<\/code>/g,
      /\bMessages(?= (?:or|또는) Chat Completions\b)/g,
      /\bChat Completions\b/g
    ]
    const identifiers = (text: string): string[] =>
      patterns
        .flatMap((pattern) => text.match(pattern) ?? [])
        .sort((left, right) => left.localeCompare(right))
    const offenders = Object.entries(catalog('ko'))
      .filter(
        ([key, value]) =>
          JSON.stringify(identifiers(englishOf(key))) !== JSON.stringify(identifiers(value))
      )
      .map(([key]) => key)

    expect(offenders).toEqual([])
  })

  const localizedFeatureTerms = {
    fr: {
      agent: 'agent',
      skill: 'compétence',
      untranslatedAgent: /\bsubagents?\b/i,
      untranslatedSkill: /\bskills?\b/i
    },
    'zh-Hans': {
      agent: '智能体',
      skill: '技能',
      untranslatedAgent: /\b(?:sub)?agents?\b/i,
      untranslatedSkill: /\bskills?\b/i
    },
    'zh-Hant': {
      agent: '智能體',
      skill: '技能',
      untranslatedAgent: /\b(?:sub)?agents?\b/i,
      untranslatedSkill: /\bskills?\b/i
    },
    ja: {
      agent: 'エージェント',
      skill: 'スキル',
      untranslatedAgent: /\b(?:sub)?agents?\b/i,
      untranslatedSkill: /\bskills?\b/i
    },
    ko: {
      agent: '에이전트',
      skill: '스킬',
      untranslatedAgent: /\b(?:sub)?agents?\b/i,
      untranslatedSkill: /\bskills?\b/i
    },
    ru: {
      agent: /агент/iu,
      skill: /навык/iu,
      untranslatedAgent: /\b(?:sub)?agents?\b/i,
      untranslatedSkill: /\bskills?\b/i
    }
  } satisfies Record<
    TranslatedLocale,
    {
      agent: string | RegExp
      skill: string | RegExp
      untranslatedAgent: RegExp
      untranslatedSkill: RegExp
    }
  >

  it.each(TRANSLATED)('%s localizes Agent and Skill in user-visible prose', (locale) => {
    const expected = localizedFeatureTerms[locale]
    const offenders = Object.entries(catalog(locale)).flatMap(([key, value]) => {
      const source = withoutTechnicalIdentifiers(englishOf(key))
      const prose = withoutTechnicalIdentifiers(value)
      return [
        {
          source: /\b(?:sub)?agents?\b/i,
          untranslated: expected.untranslatedAgent,
          expected: expected.agent
        },
        {
          source: /\bskills?\b/i,
          untranslated: expected.untranslatedSkill,
          expected: expected.skill
        }
      ]
        .filter(
          ({ source: pattern, untranslated, expected: term }) =>
            pattern.test(source) &&
            (!(typeof term === 'string'
              ? prose.toLocaleLowerCase(locale).includes(term.toLocaleLowerCase(locale))
              : term.test(prose)) ||
              untranslated.test(prose))
        )
        .map(({ expected: term }) => `${key}: ${String(term)}`)
    })

    expect(offenders).toEqual([])
  })

  const credentialTokenSource = [
    /\b(?:Claude|GitHub|OAuth|setup|saved|replacement|access)\s+tokens?\b/i,
    /\b(?:paste|save|remove|use|manage|prefer|exclude|read)\b[^.]*\btokens?\b/i,
    /\btokens?\s+(?:verified|verification|excluded)\b/i,
    /^Token:/
  ]
  const localizedTokenTerms = {
    fr: { credential: 'jeton', model: 'jeton' },
    'zh-Hans': { credential: '令牌', model: '词元' },
    'zh-Hant': { credential: '權杖', model: '詞元' },
    ja: { credential: 'トークン', model: 'トークン' },
    ko: { credential: '토큰', model: '토큰' },
    ru: { credential: 'токен', model: 'токен' }
  } satisfies Record<TranslatedLocale, { credential: string; model: string }>

  it.each(TRANSLATED)('%s translates token according to credential or model context', (locale) => {
    const expected = localizedTokenTerms[locale]
    const offenders = Object.entries(catalog(locale)).flatMap(([key, value]) => {
      const source = withoutTechnicalIdentifiers(englishOf(key))
      if (!/\btokens?\b/i.test(source)) return []

      const prose = withoutTechnicalIdentifiers(value)
      const term = credentialTokenSource.some((pattern) => pattern.test(source))
        ? expected.credential
        : expected.model
      return !prose.toLocaleLowerCase(locale).includes(term.toLocaleLowerCase(locale)) ||
        /\btokens?\b/i.test(prose)
        ? [`${key}: ${term}`]
        : []
    })

    expect(offenders).toEqual([])
  })

  it.each(TRANSLATED)('%s localizes generic product nouns', (locale) => {
    const localizedGlossary = [
      { source: /\bSpecialists?\b/i, untranslated: /\bSpecialists?\b/i },
      { source: /\bMarketplace\b/, untranslated: /\bMarketplace\b/ },
      { source: /\bConnectors?\b/i, untranslated: /\bConnectors?\b/i },
      { source: /\bMain\b/, untranslated: /\bMain\b/ }
    ]
    const retainedIdentifiersAndNames = [
      /\b(?:specialist\.json|openscience-specialist-template\.zip)\b/gi,
      /Claude Connectors Directory/g,
      /Specialist Marketplace protocol/g,
      /(?:GitHub|Azure|Microsoft|Visual Studio) Marketplace/g
    ]
    const offenders = Object.entries(catalog(locale)).flatMap(([key, value]) => {
      const source = englishOf(key).replace(/\{\{\w+\}\}/g, '')
      const prose = retainedIdentifiersAndNames.reduce(
        (text, retained) => text.replace(retained, ''),
        value
      )
      return localizedGlossary
        .filter(
          ({ source: pattern, untranslated }) => pattern.test(source) && untranslated.test(prose)
        )
        .map(() => key)
    })

    expect(offenders).toEqual([])
  })

  it('uses Russian glossary terms throughout user-visible prose', () => {
    const entries = Object.entries(catalog('ru'))
    const glossary = [
      { source: /\bconversations?\b/i, translated: /диалог/iu },
      { source: /\bproviders?\b/i, translated: /поставщик/iu },
      { source: /\bCompute Hosts?\b/i, translated: /вычислительн[а-яё]*\s+уз/iu },
      { source: /\bicons?\b/i, translated: /знач(?:ок|к)/iu },
      { source: /\bTags?\b/i, translated: /тег/iu },
      { source: /\bCapabilit(?:y|ies)\b/i, translated: /возможност/iu }
    ]
    const glossaryOffenders = entries.flatMap(([key, value]) => {
      const source = withoutTechnicalIdentifiers(englishOf(key))
      const translation = withoutTechnicalIdentifiers(value)
      return glossary
        .filter(
          ({ source: sourcePattern, translated }) =>
            sourcePattern.test(source) && !translated.test(translation)
        )
        .map(() => key)
    })
    const connectorOffenders = entries
      .filter(([key]) => /\bConnectors?\b/i.test(withoutTechnicalIdentifiers(englishOf(key))))
      .filter(([, value]) => !/коннектор/iu.test(withoutTechnicalIdentifiers(value)))
      .map(([key]) => key)
    const credentialOffenders = entries
      .filter(([key]) => /\bcredentials?\b/i.test(withoutTechnicalIdentifiers(englishOf(key))))
      .filter(([, value]) => !/уч[её]тн[а-яё]*\s+данн/iu.test(withoutTechnicalIdentifiers(value)))
      .map(([key]) => key)

    expect({ glossaryOffenders, connectorOffenders, credentialOffenders }).toEqual({
      glossaryOffenders: [],
      connectorOffenders: [],
      credentialOffenders: []
    })
  })

  it('preserves Russian networking and product literals', () => {
    const literals = ['Claude Code', 'Wi-Fi', '*.internal.example', '10.0.0.0/8']
    const offenders = Object.entries(catalog('ru')).flatMap(([key, value]) =>
      literals
        .filter((literal) => englishOf(key).includes(literal) && !value.includes(literal))
        .map((literal) => `${key}: ${literal}`)
    )

    expect(offenders).toEqual([])
  })
})

describe('Russian catalog quality', () => {
  it('does not leave generic English implementation terms in Russian prose', () => {
    const retained = [
      /\{\{\w+\}\}/g,
      /<(?:code|path)>.*?<\/(?:code|path)>/g,
      /Specialist Marketplace protocol/g,
      /ssh-agent/g
    ]
    const offenders = Object.entries(catalog('ru'))
      .filter(([, value]) => {
        const prose = retained.reduce((text, pattern) => text.replace(pattern, ''), value)
        return (
          /\b(?:account|alias|backend|Beaker|connection|framework|frontmatter|job|module|output|partition|Provenance|runtimes?|Sandbox|Сandbox|Write)\b/i.test(
            prose
          ) || prose.includes('e.g.')
        )
      })
      .map(([key]) => key)

    expect(offenders).toEqual([])
  })

  it('does not contain unrelated writing systems or inconsistent Side chat terminology', () => {
    const entries = Object.entries(catalog('ru'))
    const unrelatedScripts = entries
      .filter(([, value]) => /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(value))
      .map(([key]) => key)
    const sideChat = entries
      .filter(([key]) => englishOf(key).includes('Side chat'))
      .filter(([, value]) => !/боков[а-яё]*\s+(?:чат|чате|чата)/iu.test(value))
      .map(([key]) => key)

    expect({ unrelatedScripts, sideChat }).toEqual({ unrelatedScripts: [], sideChat: [] })
  })

  it.each([
    [
      ".md files need a name and description in YAML frontmatter. .zip or .skill bundles must contain a SKILL.md. You'll confirm before anything is added.",
      'Файлы .md должны содержать имя и описание в метаданных YAML. Архивы .zip и пакеты .skill должны содержать SKILL.md. Перед добавлением потребуется подтверждение.'
    ],
    [
      'A reviewer agent checks every change before it lands.',
      'Агент-рецензент проверяет каждое изменение перед его внесением.'
    ],
    ['Agent/framework overhead', 'Накладные расходы агента и фреймворка'],
    [
      'Base URL, key, and model for a Messages or Chat Completions endpoint',
      'Базовый URL, ключ и модель для конечной точки Messages или Chat Completions'
    ],
    [
      'Imported {{imported}} · skipped {{skipped}} · failed {{failed}}',
      'Импортировано: {{imported}} · пропущено: {{skipped}} · с ошибкой: {{failed}}'
    ],
    [
      'Current local edits are not recoverable after a successful overwrite. A failed atomic install preserves the current version.',
      'Текущие локальные изменения невозможно восстановить после успешной перезаписи. При неудачной атомарной установке сохраняется текущая версия.'
    ],
    [
      'Your local edits are preserved. Reload to get the latest version (your unsaved changes will be discarded), or cancel and try again.',
      'Ваши локальные изменения сохранены. Перезагрузите страницу, чтобы получить последнюю версию (несохранённые изменения будут потеряны), или отмените действие и повторите попытку.'
    ],
    ['Preview uploaded attachment {{name}}', 'Предпросмотр загруженного вложения {{name}}'],
    [
      "Open Science will recreate the folder as you use it. Files from the old location won't be available until it's reconnected.",
      'Open Science воссоздаст папку при следующем обращении к ней. Файлы из прежнего расположения будут недоступны, пока подключение не восстановится.'
    ],
    [
      'Open Science could not finish recovering a previous project deletion. Retry recovery before archiving or deleting projects.',
      'Open Science не удалось завершить восстановление после предыдущего удаления проекта. Повторите восстановление перед архивированием или удалением проектов.'
    ],
    ['SSH alias', 'Псевдоним SSH'],
    [
      'The Compute Host connection timed out.',
      'Истекло время ожидания подключения к вычислительному узлу.'
    ],
    [
      'Port must be an integer from 1 through 65535.',
      'Порт должен быть целым числом от 1 до 65535.'
    ],
    [
      ' (control tab falls back to most recent data kernel)',
      '(вкладка управления возвращается к последнему ядру данных)'
    ],
    [
      'A custom Connector with this name already exists.',
      'Пользовательский коннектор с таким именем уже существует.'
    ],
    ['Agent installation blockers', 'Причины блокировки установки агента'],
    ['Agent runtime', 'Среда выполнения агента'],
    ['Agent runtime repair issues', 'Проблемы восстановления среды выполнения агента'],
    ['Auto-discover from MCP server', 'Автоматически обнаруживать на сервере MCP'],
    ['Auto-review', 'Автопроверка'],
    [
      'Claude sign-out did not complete. Try again.',
      'Не удалось выйти из Claude. Повторите попытку.'
    ],
    ['Collapse sidebar panel', 'Свернуть боковую панель'],
    [
      'Current composition and terminal-run history for the active branch. Category values are estimates.',
      'Текущая структура и история запусков в терминале для активной ветви. Значения категорий приблизительны.'
    ],
    ['Custom command', 'Пользовательская команда'],
    ['Idle', 'Бездействует'],
    ['Invalid JSON', 'Некорректный JSON'],
    ['Invalid JSON: {{error}}', 'Некорректный JSON: {{error}}'],
    ['API format', 'Формат API'],
    ['API key', 'API-ключ'],
    ['API key is required.', 'Укажите API-ключ.'],
    ['Offline', 'Офлайн'],
    ['Runtimes', 'Среды выполнения'],
    [
      'Preview — matches the list and picker.',
      'Предпросмотр соответствует списку и средству выбора.'
    ],
    [
      'Recommended. Uses your existing Claude login from ~/.claude. Sign in once via browser OAuth and use across all Claude tools.',
      'Рекомендуется. Использует существующий вход Claude из ~/.claude. Один раз войдите через OAuth в браузере и используйте этот вход во всех инструментах Claude.'
    ],
    ['The selected folder is not usable.', 'Выбранную папку нельзя использовать.'],
    [
      'The source session was deleted before an applicable review was captured.',
      'Исходная сессия была удалена до сохранения подходящей проверки.'
    ],
    ['Used by Auto-review', 'Используется автопроверкой'],
    [
      'Deletion failed and was rolled back.',
      'Удаление завершилось ошибкой, и изменения были отменены.'
    ],
    [
      'Owned Skill · v{{version}} · bundled by default.',
      'Собственный навык · v{{version}} · включён по умолчанию.'
    ],
    [
      'Saves a file as an artifact for this conversation.',
      'Сохраняет файл как артефакт этого диалога.'
    ],
    [
      'Remote access is off on the home computer. Re-enable a remote access mode in Open Science, then try again.',
      'Удалённый доступ отключён на домашнем компьютере. Снова включите режим удалённого доступа в Open Science и повторите попытку.'
    ],
    [
      'That folder already contains Open Science data. Pick an empty folder, or use the default location.',
      'Эта папка уже содержит данные Open Science. Выберите пустую папку или используйте расположение по умолчанию.'
    ],
    [
      'This model is not supported over the Codex Chat Completions bridge. Pick another model for a Codex session.',
      'Эта модель не поддерживается мостом Codex Chat Completions. Выберите другую модель для сессии Codex.'
    ],
    [
      'Leave empty to use User from ~/.ssh/config.',
      'Оставьте пустым, чтобы использовать имя пользователя из ~/.ssh/config.'
    ],
    [
      'A password must be configured before this Compute Host can connect.',
      'Перед подключением этого вычислительного узла настройте пароль.'
    ],
    [
      'Configure a password for this Compute Host before trying again.',
      'Настройте пароль для этого вычислительного узла и повторите попытку.'
    ],
    [
      'Open Science maps five relative strengths onto the exact levels accepted by this model.',
      'Open Science сопоставляет пять относительных уровней с точными уровнями, поддерживаемыми этой моделью.'
    ],
    [
      'Installed Skill · v{{version}} · include it to bundle a copy.',
      'Установленный навык · v{{version}} · включите его, чтобы добавить копию в пакет.'
    ],
    [
      'Downloaded {{downloaded}} of {{total}} artifacts. {{failed}} failed.',
      'Скачано артефактов: {{downloaded}} из {{total}}. Ошибок: {{failed}}.'
    ],
    [
      'Open Science exited before this copy finished. Your current data is untouched. Discard the incomplete copy to use this location again.',
      'Open Science завершил работу до окончания копирования. Текущие данные не изменены. Удалите неполную копию, чтобы снова использовать это расположение.'
    ],
    ['Publisher: {{publisher}}', 'Издатель: {{publisher}}'],
    ['{{agent}} cannot be accessed.', '{{agent}} недоступен.'],
    [
      '{{fileName}}: unsupported file — upload a .md file or a .zip / .skill bundle.',
      '{{fileName}}: неподдерживаемый файл — загрузите файл .md либо пакет .zip или .skill.'
    ],
    ['remote commands on {{host}}', 'удалённые команды на {{host}}'],
    ['Optional display name', 'Необязательное отображаемое имя'],
    ['scheduler', 'планировщик'],
    ['Cache share', 'Доля кэша'],
    ['Signing key fingerprint: {{fingerprint}}', 'Отпечаток ключа подписи: {{fingerprint}}'],
    ['Molecule renderer failed to load', 'Не удалось загрузить визуализатор молекул'],
    ['Amber', 'Янтарный'],
    ['Teal', 'Бирюзовый'],
    ['Slate', 'Сланцевый'],
    ['Re-detect', 'Проверить снова'],
    ['Runtime', 'Среда выполнения'],
    ['SCOPE & FEASIBILITY', 'ОБЛАСТЬ И ОСУЩЕСТВИМОСТЬ'],
    [
      'Remote commands run as your account on the host and are not sandboxed. Approve only if you trust this command.',
      'Удалённые команды выполняются на узле от имени вашей учётной записи без изоляции. Разрешайте выполнение только тех команд, которым доверяете.'
    ],
    ['Remote job details', 'Сведения об удалённом задании'],
    ['Remote job: {{intent}}', 'Удалённое задание: {{intent}}'],
    [
      'Test failed: could not reach the endpoint — check the base URL/connection.',
      'Тест не пройден: не удалось подключиться к конечной точке — проверьте базовый URL или подключение.'
    ],
    [
      'This name is reserved by a built-in Connector.',
      'Это имя зарезервировано встроенным коннектором.'
    ],
    [
      'This plan is shown as a saved snapshot. Step progress is unavailable for archived sessions.',
      'Этот план отображается как сохранённый снимок. Ход выполнения шагов недоступен для архивных сессий.'
    ],
    ['Beaker', 'Лабораторный стакан'],
    ['Close Provenance', 'Закрыть сведения о происхождении'],
    ['Open Provenance for {{title}}', 'Открыть сведения о происхождении для {{title}}'],
    ['Open settings navigation', 'Открыть навигацию по настройкам'],
    ['Use {{name}}', 'Использовать {{name}}'],
    ['Go to home folder', 'Перейти в домашнюю папку'],
    [
      'Sandbox tools that run without preview',
      'Инструменты песочницы, которые запускаются без предпросмотра'
    ],
    [
      'Your research data is in a hidden folder. Moving it into a visible OpenScience folder makes it easy to find and back up — your settings and history stay where they are.',
      'Ваши исследовательские данные находятся в скрытой папке. Перемещение их в видимую папку OpenScience упростит поиск и резервное копирование — настройки и история останутся на прежнем месте.'
    ],
    ['System Tags stay first', 'Системные теги всегда остаются в начале'],
    ['Reorder {{tag}}', 'Изменить порядок тега {{tag}}'],
    ['Moved {{tag}} to position {{position}}.', 'Тег {{tag}} перемещён на позицию {{position}}.'],
    ['Could not reorder Tags. Try again.', 'Не удалось изменить порядок тегов. Попробуйте снова.'],
    [
      'Could not stop background processes before updating. Please try again.',
      'Не удалось остановить фоновые процессы перед обновлением. Повторите попытку.'
    ],
    [
      'Could not fully stop background processes before updating. Please try again.',
      'Не удалось завершить все фоновые процессы перед обновлением. Повторите попытку.'
    ],
    [
      'Cancel this update, then use Reveal in Settings → General → Diagnostics to locate the log file. Quit and reopen Open Science, then try the update again. If the problem returns, review the log for local file paths and give it to a developer or <issueLink>open a GitHub issue</issueLink>.',
      'Отмените обновление, затем в разделе «Настройки → Общие → Диагностика» нажмите «Показать», чтобы найти файл журнала. Полностью закройте Open Science, снова откройте приложение и повторите обновление. Если ошибка повторится, проверьте, нет ли в журнале локальных путей к файлам, и передайте его разработчику или <issueLink>создайте обращение на GitHub</issueLink>.'
    ],
    ['Why this happened', 'Почему это произошло'],
    ['How to fix', 'Как исправить'],
    ['Still stuck? Create an issue for help', 'Проблема не решена? Создать обращение'],
    [
      'Opens GitHub with a pre-filled issue: the error code, app version, and error stack. Personal paths are redacted (your home folder becomes ~). Please review before submitting — you can delete the stack section if you prefer.',
      'На GitHub откроется заранее заполненное обращение с кодом ошибки, версией приложения и стеком вызовов. Личные пути в файловой системе будут скрыты (домашняя папка заменена на ~). Проверьте содержимое перед отправкой. При желании раздел со стеком вызовов можно удалить.'
    ],
    ['Skill import menu — 8 states', 'Меню импорта навыков — 8 состояний'],
    ['Import', 'Импортировать'],
    ['Upload skills', 'Загрузить навыки'],
    ['Import from GitHub', 'Импортировать из GitHub'],
    ['Import installed skills', 'Импортировать установленные навыки'],
    ['Scan global skill folders', 'Найти навыки в глобальных папках'],
    [
      'Could not scan storage usage. Try again.',
      'Не удалось подсчитать объём занятого места. Повторите попытку.'
    ],
    ['Last checked {{time}}', 'Последняя проверка: {{time}}'],
    ['Last scanned {{time}}', 'Последнее сканирование: {{time}}'],
    ['Refresh', 'Обновить'],
    ["Settings panel couldn't be loaded.", 'Не удалось загрузить раздел настроек.'],
    [
      'Reload Open Science to try loading this panel again.',
      'Перезапустите Open Science, чтобы снова попробовать загрузить этот раздел.'
    ],
    ['{{count}} more messages_one', 'Ещё {{count}} сообщение'],
    ['{{count}} more messages_few', 'Ещё {{count}} сообщения'],
    ['{{count}} more messages_many', 'Ещё {{count}} сообщений'],
    ['{{count}} more messages_other', 'Ещё {{count}} сообщения'],
    [
      'Run jobs on a remote SSH host, or manage hosts.',
      'Выполнять задания на удалённом узле по SSH или управлять узлами.'
    ],
    ['Enable {{name}}', 'Включить {{name}}'],
    ['Disable {{name}}', 'Отключить {{name}}'],
    ['Add {{name}} to run targets', 'Добавить {{name}} в список узлов для выполнения заданий'],
    ['Remove {{name}} from run targets', 'Убрать {{name}} из списка узлов для выполнения заданий'],
    [
      'Select as target host to run jobs',
      'Выбрать в качестве целевого узла для выполнения заданий'
    ],
    ['Remove from target hosts', 'Убрать из списка целевых узлов'],
    ['Selected hosts are used to run jobs.', 'На выбранных узлах выполняются задания.'],
    ['Open settings for {{name}}', 'Открыть настройки {{name}}'],
    ['Change execution targets', 'Изменить выбор узлов'],
    ['Compute execution target: {{name}}', 'Целевой вычислительный узел: {{name}}'],
    ['Compute execution targets: {{names}}', 'Целевые вычислительные узлы: {{names}}'],
    ['Client ID', 'Идентификатор клиента'],
    ['Pre-registered client ID', 'Идентификатор заранее зарегистрированного клиента'],
    ['Client secret', 'Секрет клиента'],
    [
      'Leave blank to keep the saved secret',
      'Оставьте поле пустым, чтобы сохранить текущий секрет'
    ],
    ['Pre-registered client secret', 'Секрет заранее зарегистрированного клиента'],
    ['The saved client secret will be removed.', 'Сохранённый секрет клиента будет удалён.'],
    ['A client secret is saved securely.', 'Секрет клиента хранится в защищённом виде.'],
    ['Keep saved client secret', 'Сохранить текущий секрет клиента'],
    ['Remove saved client secret', 'Удалить сохранённый секрет клиента'],
    [
      'This imported Connector requires a client secret entered locally.',
      'Для импортированного коннектора необходимо локально ввести секрет клиента.'
    ],
    [
      'Authorization server URL is required for a pre-registered client.',
      'Для заранее зарегистрированного клиента требуется URL сервера авторизации.'
    ],
    [
      'Client ID is required when a client secret is configured.',
      'Если настроен секрет клиента, необходимо указать идентификатор клиента.'
    ],
    [
      'Client metadata URL cannot be combined with a pre-registered client.',
      'URL метаданных клиента нельзя использовать вместе с заранее зарегистрированным клиентом.'
    ],
    [
      'SSH configuration verified and activated. Saved password deleted. Select this Compute Host again as an execution target in each Session and approve new Permission Grants.',
      'Конфигурация SSH проверена и активирована. Сохранённый пароль удалён. В каждой сессии снова выберите этот вычислительный узел для выполнения заданий и предоставьте новые разрешения.'
    ],
    [
      'Password authentication verified and activated. Select this Compute Host again as an execution target in each Session and approve new Permission Grants.',
      'Аутентификация по паролю проверена и активирована. В каждой сессии снова выберите этот вычислительный узел для выполнения заданий и предоставьте новые разрешения.'
    ],
    [
      'Username changed. Select this Compute Host again as an execution target in each Session and approve new Permission Grants.',
      'Имя пользователя изменено. В каждой сессии снова выберите этот вычислительный узел для выполнения заданий и предоставьте новые разрешения.'
    ],
    [
      'Connection settings verified and saved. Select this Compute Host again as an execution target in each Session and approve new Permission Grants.',
      'Настройки подключения проверены и сохранены. В каждой сессии снова выберите этот вычислительный узел для выполнения заданий и предоставьте новые разрешения.'
    ]
  ])('keeps proofread Russian copy for %s', (key, expected) => {
    expect(catalog('ru')[key]).toBe(expected)
  })

  it.each([
    [
      'This Connector no longer exists. Your draft has not been saved.',
      'Этот коннектор больше не существует. Черновик не сохранён.'
    ],
    ['Used by', 'Используют'],
    ['Available to Main Agent', 'Доступен главному агенту'],
    ['Unavailable to Main Agent', 'Недоступен главному агенту'],
    ['Filter Connectors by agent', 'Фильтровать коннекторы по агенту'],
    ['Filter Skills by agent', 'Фильтровать навыки по агенту'],
    ['All Agents/Specialists', 'Все агенты и специалисты'],
    ['Export', 'Экспортировать'],
    ['Remove', 'Удалить'],
    ['Agents with access', 'Агенты с доступом'],
    [
      'Hover to preview. Click to view every agent.',
      'Наведите курсор для предпросмотра. Нажмите, чтобы увидеть всех агентов.'
    ],
    [
      'This Provider no longer exists. Your draft has not been saved.',
      'Этот поставщик моделей больше не существует. Черновик не сохранён.'
    ],
    ['Deleted {{count}} Skills._one', 'Удалён {{count}} навык.'],
    ['Deleted {{count}} Skills._few', 'Удалено {{count}} навыка.'],
    ['Deleted {{count}} Skills._many', 'Удалено {{count}} навыков.'],
    ['Deleted {{count}} Skills._other', 'Удалено {{count}} навыка.'],
    [
      'Some selected Skills could not be deleted. They remain selected.',
      'Не удалось удалить некоторые выбранные навыки. Они остались выбранными.'
    ],
    ['Delete selected ({{selectedCount}})', 'Удалить выбранные ({{selectedCount}})'],
    ['Delete selected Skills?', 'Удалить выбранные навыки?'],
    [
      'Deleted Skills are removed from this device and cannot be recovered.',
      'Навыки будут удалены с этого устройства без возможности восстановления.'
    ],
    ['{{count}} selected Skills can be deleted._one', 'Можно удалить {{count}} выбранный навык.'],
    ['{{count}} selected Skills can be deleted._few', 'Можно удалить {{count}} выбранных навыка.'],
    [
      '{{count}} selected Skills can be deleted._many',
      'Можно удалить {{count}} выбранных навыков.'
    ],
    [
      '{{count}} selected Skills can be deleted._other',
      'Можно удалить {{count}} выбранного навыка.'
    ],
    ['{{count}} protected Skills will be kept._one', '{{count}} защищённый навык будет сохранён.'],
    [
      '{{count}} protected Skills will be kept._few',
      '{{count}} защищённых навыка будут сохранены.'
    ],
    [
      '{{count}} protected Skills will be kept._many',
      '{{count}} защищённых навыков будут сохранены.'
    ],
    [
      '{{count}} protected Skills will be kept._other',
      '{{count}} защищённого навыка будет сохранено.'
    ],
    ['Owned by a Specialist.', 'Принадлежит специалисту.'],
    ['Used by a Specialist.', 'Используется специалистом.'],
    ['Delete {{count}} Skills_one', 'Удалить {{count}} навык'],
    ['Delete {{count}} Skills_few', 'Удалить {{count}} навыка'],
    ['Delete {{count}} Skills_many', 'Удалить {{count}} навыков'],
    ['Delete {{count}} Skills_other', 'Удалить {{count}} навыка'],
    [
      'View Connector availability for {{count}} agents_one',
      'Показать доступность коннектора для {{count}} агента'
    ],
    [
      'View Connector availability for {{count}} agents_few',
      'Показать доступность коннектора для {{count}} агентов'
    ],
    [
      'View Connector availability for {{count}} agents_many',
      'Показать доступность коннектора для {{count}} агентов'
    ],
    [
      'View Connector availability for {{count}} agents_other',
      'Показать доступность коннектора для {{count}} агентов'
    ],
    [
      'View Skill availability for {{count}} agents_one',
      'Показать доступность навыка для {{count}} агента'
    ],
    [
      'View Skill availability for {{count}} agents_few',
      'Показать доступность навыка для {{count}} агентов'
    ],
    [
      'View Skill availability for {{count}} agents_many',
      'Показать доступность навыка для {{count}} агентов'
    ],
    [
      'View Skill availability for {{count}} agents_other',
      'Показать доступность навыка для {{count}} агентов'
    ],
    ['Used by Agents and Specialists', 'Используется агентами и специалистами'],
    ['Open {{name}} in Specialist Settings', 'Открыть настройки специалиста {{name}}']
  ])('keeps native Russian resource-management copy for %s', (key, expected) => {
    expect(catalog('ru')[key]).toBe(expected)
  })

  it('does not use literal machine-translation markers in Russian UI copy', () => {
    const forbidden = [
      /опциональ/iu,
      /предварительн\S* просмотр/iu,
      /рабоч(?:ая|ей|ую|ие|их) зон/iu,
      /\b(?:Claude|Codex) логин/iu,
      /\bAPI ключ/iu,
      /\bMCP инструмент/iu,
      /Open Science долж(?:ен|на|но|ны)/iu,
      /несборн/iu,
      /живые отнош/iu,
      /шаблон вкладки/iu,
      /проектн(?:ый|ого) идентификатор/iu,
      /на поверхности/iu,
      /повторно обнаруж/iu,
      /системный ящик/iu,
      /дистанционн/iu,
      /кастомн/iu,
      /JSON файла/iu,
      /\b(?:удаленн|сохраненн|остается|прервет)\S*/iu,
      /\bтемная\b/iu,
      /уровн\S* усили/iu,
      /с удаленного/iu,
      /сессионное разрешение/iu,
      /сохранённое настройки/iu,
      /настройка аутентификации кандидата/iu,
      /отклонить (?:неполный набор данных|копию)/iu,
      /\bв Bulk\b/iu,
      /разработчиков, которых вы доверяете/iu,
      /неподвижный ID/iu,
      /существующего Codex входа/iu,
      /приходящая версия/iu,
      /приложени[ея] для рабочего стола/iu,
      /\bневалидн/iu,
      /переиспользован/iu,
      /открытый исходный код/iu,
      /\bкомпозер/iu,
      /Codex мост/iu,
      /идут сюда/iu,
      /синтаксис Mermaid не может быть отображен/iu,
      /следующий редактированный сообщение/iu,
      /нет хостов SSH ещё/iu,
      /другой ключевое слово/iu,
      /один предложение/iu,
      /OAuth диапазонов/iu,
      /на следующем сканировании/iu,
      /перезапустите настройки проекта/iu,
      /перемещ[её]н\S* в сторону/iu,
      /ошибки проверки блокировки/iu,
      /системный хранитель/iu,
      /перед попыткой снова/iu,
      /тест и (?:обновление|сохранение)/iu,
      /повторное обнаружение/iu,
      /показывается данные/iu,
      /специалиста ZIP/iu,
      /опции отправки/iu,
      /Настройки → разрешений/iu,
      /ключ API/iu,
      /вход Codex/iu,
      /журнал ревью/iu,
      /ревьюер/iu
    ]
    const offenders = Object.entries(catalog('ru'))
      .filter(([, value]) => forbidden.some((pattern) => pattern.test(value)))
      .map(([key]) => key)

    expect(offenders).toEqual([])
  })

  it('uses context-appropriate Russian terminology for approvals', () => {
    const offenders = Object.entries(catalog('ru'))
      .filter(([key]) => /\bapprov(?:e|ed|es|ing|al|als)\b/i.test(englishOf(key)))
      .filter(([, value]) => /одобр|согласова|согласи/iu.test(value))
      .map(([key]) => key)

    expect(offenders).toEqual([])
    expect(catalog('ru').Approve).toBe('Утвердить')
    expect(
      catalog('ru')[
        'Choose "Always trust this browser" to skip approval on future visits to the same remote address.'
      ]
    ).toContain('разрешение на доступ')
  })

  it('uses native Russian terminology for reasoning depth', () => {
    const offenders = Object.entries(catalog('ru'))
      .filter(([key]) => /reasoning effort/i.test(englishOf(key)))
      .filter(([, value]) => !/глубин\S* рассуждени/iu.test(value))
      .map(([key]) => key)

    expect(offenders).toEqual([])
  })

  it.each([
    [
      "Conversations still bound to <name>{{name}}</name> will become <em>unavailable</em> and will <em>not</em> be switched to Main Agent automatically. For each affected conversation you'll explicitly choose a new specialist or Main Agent before it can send again.",
      'Диалоги, по-прежнему связанные с <name>{{name}}</name>, станут <em>недоступны</em> и <em>не</em> будут автоматически переключены на главного агента. Для каждого затронутого диалога потребуется явно выбрать нового специалиста или главного агента, прежде чем снова можно будет отправлять сообщения.'
    ],
    ['FIRST-TIME SETUP', 'ПЕРВОНАЧАЛЬНАЯ НАСТРОЙКА'],
    ['Identity', 'Профиль'],
    ['{{name}} scrollable preview', 'Предпросмотр {{name}} с прокруткой'],
    ['System', 'Системный'],
    ['System_theme', 'Системная'],
    ['System_language', 'Как в системе'],
    ['System_runtime', 'Системная'],
    [
      'Pick the agent Open Science drives, then install it. Only this agent needs to be installed to continue.',
      'Выберите агента, которым будет управлять Open Science, затем установите его. Для продолжения достаточно установить только этого агента.'
    ],
    ['Read-only', 'Только чтение'],
    [
      'Creates Plans and records decisions you make during review. This Permission Grant never approves a Plan; you must approve each Plan separately.',
      'Создаёт планы и записывает решения, принятые во время проверки. Это разрешение не утверждает план: каждый план необходимо утверждать отдельно.'
    ],
    [
      'Remote.It is a third-party service. Open Science only calls its user-installed desktop CLI and does not include, redistribute, register, or create an account for it.',
      'Remote.It — сторонний сервис. Open Science лишь вызывает установленный пользователем настольный CLI-клиент и не включает его в поставку, не распространяет, не регистрирует и не создаёт для него учётную запись.'
    ],
    ['Incomplete data copy found', 'Обнаружена неполная копия данных'],
    ['Verified data copy found', 'Обнаружена проверенная копия данных'],
    [
      'A completed copy from an interrupted move is ready. Finish the move to switch locations and restart, or discard the copy to stay where you are.',
      'Готова полная копия данных, оставшаяся после прерванного переноса. Завершите перенос, чтобы перейти к новому расположению и перезапустить приложение, или удалите копию, чтобы остаться в текущем расположении.'
    ],
    [
      'A verified copy from an interrupted move was found here. You can finish the move without copying everything again, or discard it.',
      'Здесь обнаружена проверенная копия данных после прерванного переноса. Можно завершить перенос без повторного копирования всех данных или удалить эту копию.'
    ],
    [
      'An incomplete copy from an interrupted move was found here. Discard it before using this location again.',
      'Здесь обнаружена неполная копия данных после прерванного переноса. Удалите её перед повторным использованием этого расположения.'
    ],
    ['Resolve unfinished move', 'Разобраться с переносом'],
    ['Finish move', 'Завершить перенос'],
    [
      'Restart to switch to the new location. Nothing is changed until you do — choose Keep current location to stay where you are and discard the copy.',
      'Перезапустите приложение, чтобы перейти к новому расположению. До перезапуска ничего не изменится. Чтобы остаться в текущем расположении и удалить копию, выберите «Оставить текущее расположение».'
    ],
    [
      'This folder already contains Open Science data. It will be <em>used as-is (not merged)</em> — <em>your current data folder is kept, so you can switch back</em>. The app will restart.',
      'В этой папке уже есть данные Open Science. Она будет <em>использована без изменений (без объединения)</em> — <em>текущая папка с данными останется на месте, поэтому к ней можно будет вернуться</em>. Приложение перезапустится.'
    ],
    [
      "Your data folder <path>{{path}}</path> can't be found. It may have been deleted, or it's on a drive that isn't connected.",
      'Не найдена папка с данными <path>{{path}}</path>. Возможно, она удалена или находится на неподключённом диске.'
    ],
    [
      'Authentication change blocked. Finish or safely delete active and unharvested Compute Jobs first.',
      'Изменение способа аутентификации заблокировано. Сначала завершите активные вычислительные задания и задания с несобранными результатами либо безопасно удалите их.'
    ]
  ])('keeps reviewed high-risk copy for %s', (key, expected) => {
    expect(catalog('ru')[key]).toBe(expected)
  })
})

describe('Japanese safety copy', () => {
  it.each([
    ['Allow globally', 'すべてのプロジェクトで許可'],
    ['-y @modelcontextprotocol/server-memory', '-y @modelcontextprotocol/server-memory'],
    ['*.internal.example, 10.0.0.0/8', '*.internal.example, 10.0.0.0/8'],
    ['Approval applies to this call only.', '承認はこのツール呼び出しにのみ適用されます。'],
    ['This call only', 'このツール呼び出しのみ'],
    [
      'Individual grants remain revocable; Revoke all is disabled until the complete set is known.',
      '個別の許可は引き続き取り消せます。すべての許可が判明するまで「すべて取り消す」は無効です。'
    ],
    ['{{count}} allowed this session_other', 'このセッションで {{count}} 件を許可済み']
  ])('preserves the scope of %s', (key, expected) => {
    expect(catalog('ja')[key]).toBe(expected)
  })
})

describe('Korean safety copy', () => {
  it.each([
    ['Allow globally', '모든 프로젝트에서 허용'],
    ['Allow for this project', '이 프로젝트에서 허용'],
    ['Clear all session grants', '모든 세션 권한 지우기'],
    ['Grant folder…', '폴더 권한 부여…'],
    ['Grant this folder', '이 폴더에 권한 부여'],
    ['-y @modelcontextprotocol/server-memory', '-y @modelcontextprotocol/server-memory'],
    ['*.internal.example, 10.0.0.0/8', '*.internal.example, 10.0.0.0/8'],
    ['Approval applies to this call only.', '승인은 이 호출에만 적용됩니다.'],
    ['This call only', '이 호출만'],
    [
      'Auto-approve edits to files in the workspace. Still ask before commands, network, and MCP.',
      '워크스페이스의 파일 편집을 자동 승인합니다. 명령, 네트워크 및 MCP 작업 전에는 계속 확인합니다.'
    ],
    [
      'Auto-approve edits to workspace files. Still ask before commands, network, and MCP tools.',
      '워크스페이스 파일 편집을 자동 승인합니다. 명령, 네트워크 및 MCP 도구를 실행하기 전에는 계속 확인합니다.'
    ],
    [
      '<em>Your existing data (~{{size}}) will be moved</em> to the new location — your files come with it, and nothing is left behind in the current folder.',
      '<em>기존 데이터(~{{size}})가 새 위치로 이동됩니다</em> — 파일도 함께 이동되며 현재 폴더에는 아무것도 남지 않습니다.'
    ],
    [
      'Choose how much the agent can do without asking when a conversation starts.',
      '대화가 시작될 때 에이전트가 묻지 않고 수행할 수 있는 작업 범위를 선택하세요.'
    ],
    [
      'New conversations can run commands, change files, execute notebook code, and access the network without asking first. Existing conversations are unchanged.',
      '새로운 대화에서는 먼저 묻지 않고 명령을 실행하고, 파일을 변경하고, Notebook 코드를 실행하고, 네트워크에 액세스할 수 있습니다. 기존 대화에는 영향을 주지 않습니다.'
    ],
    [
      "Notifications only appear while you're using another app. Tasks you cancel and failures the app retries automatically stay silent. Your operating system may ask for notification permission the first time one appears.",
      '알림은 다른 앱을 사용하는 동안에만 표시됩니다. 사용자가 취소한 작업과 앱이 자동으로 다시 시도하는 실패는 알림을 표시하지 않습니다. 알림이 처음 표시될 때 운영 체제에서 알림 권한을 요청할 수 있습니다.'
    ],
    [
      'Remote.It is a third-party service. Open Science only calls its user-installed desktop CLI and does not include, redistribute, register, or create an account for it.',
      'Remote.It은 제3자 서비스입니다. Open Science는 사용자가 설치한 데스크톱 CLI를 호출할 뿐이며, 이를 포함하거나 재배포하지 않고 등록하거나 계정을 생성하지도 않습니다.'
    ],
    [
      'This report is posted publicly on GitHub. Edit the error text below to remove anything sensitive before sharing. Your runtime log stays on this device and is never attached automatically.',
      '이 보고서는 GitHub에 공개로 게시됩니다. 공유하기 전에 아래 오류 텍스트를 편집하여 민감한 내용을 제거하세요. 런타임 로그는 이 기기에 남아 있으며 자동으로 첨부되지 않습니다.'
    ],
    [
      '{{count}} damaged saved conversations were moved aside. Project archive stays unavailable because their state cannot be verified. You can still permanently delete the project._other',
      '손상된 대화 {{count}}개를 별도 위치로 옮겼습니다. 상태를 확인할 수 없어 프로젝트 보관 기능은 계속 사용할 수 없습니다. 그래도 프로젝트를 영구 삭제할 수는 있습니다.'
    ],
    [
      'This will permanently delete "{{name}}" and all of its saved conversations, including any that could not be loaded during recovery. Generated artifacts and uploaded files stored by Open Science will also be deleted. Files in the project\'s working folder are not deleted. This action cannot be undone.',
      '이 작업을 실행하면 복구 중에 로드하지 못한 대화를 포함하여 “{{name}}”과 저장된 모든 대화가 영구적으로 삭제됩니다. Open Science가 저장한 생성 아티팩트와 업로드 파일도 삭제됩니다. 프로젝트 작업 폴더의 파일은 삭제되지 않습니다. 이 작업은 실행 취소할 수 없습니다.'
    ],
    [
      'This will permanently delete "{{name}}" and its {{count}} sessions. Generated artifacts and uploaded files stored by Open Science will also be deleted. Files in the project\'s working folder are not deleted. This action cannot be undone._other',
      '이 작업을 실행하면 “{{name}}”과 세션 {{count}}개가 영구적으로 삭제됩니다. Open Science가 저장한 생성 아티팩트와 업로드 파일도 삭제됩니다. 프로젝트 작업 폴더의 파일은 삭제되지 않습니다. 이 작업은 실행 취소할 수 없습니다.'
    ],
    [
      'This will permanently delete "{{name}}". Generated artifacts and uploaded files stored by Open Science will also be deleted. Files in the project\'s working folder are not deleted. This action cannot be undone.',
      '이 작업을 실행하면 “{{name}}”이 영구적으로 삭제됩니다. Open Science가 저장한 생성 아티팩트와 업로드 파일도 삭제됩니다. 프로젝트 작업 폴더의 파일은 삭제되지 않습니다. 이 작업은 실행 취소할 수 없습니다.'
    ],
    [
      'Individual grants remain revocable; Revoke all is disabled until the complete set is known.',
      '개별 권한은 계속 취소할 수 있습니다. 전체 집합이 확인될 때까지 모두 취소가 비활성화됩니다.'
    ],
    ['Declined by you: {{name}}', '사용자가 거부함: {{name}}'],
    ['declined by you', '사용자가 거부함'],
    ['{{count}} allowed this session_other', '이번 세션에서 {{count}}개 허용됨']
  ])('preserves the scope of %s', (key, expected) => {
    expect(catalog('ko')[key]).toBe(expected)
  })
})

describe('Korean language endonyms', () => {
  it('keeps Chinese language names in their own script', () => {
    expect(catalog('ko')).toMatchObject({
      简体中文: '简体中文',
      繁體中文: '繁體中文'
    })
  })
})

const KOREAN_HIDDEN_FORMATTING = /[\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u

describe('Korean native UI style', () => {
  it('does not contain hidden formatting characters', () => {
    const offenders = Object.entries(catalog('ko'))
      .filter(([, value]) => KOREAN_HIDDEN_FORMATTING.test(value))
      .map(([key]) => key)

    expect(offenders).toEqual([])
  })

  it.each(['\u061c', '\u2066', '\u2067', '\u2068', '\u2069'])(
    'recognizes hidden bidirectional control U+%s',
    (character) => {
      expect(KOREAN_HIDDEN_FORMATTING.test(character)).toBe(true)
    }
  )

  it('uses a consistent Korean product voice without translated second-person pronouns', () => {
    const unnaturalVoice = /귀하|당신|우리는|그것을|하십시오|하시기 바랍니다|기다리고 있어요/u
    const offenders = Object.entries(catalog('ko'))
      .filter(([, value]) => unnaturalVoice.test(value))
      .map(([key]) => key)

    expect(offenders).toEqual([])
  })

  it('does not pad text inside Trans placeholder tags', () => {
    const offenders = Object.entries(catalog('ko'))
      .filter(([, value]) => /<\w+>\s|\s<\/\w+>/u.test(value))
      .map(([key]) => key)

    expect(offenders).toEqual([])
  })

  it('does not expose English plural notation', () => {
    const offenders = Object.entries(catalog('ko'))
      .filter(([, value]) => /\(s\)/i.test(value))
      .map(([key]) => key)

    expect(offenders).toEqual([])
  })

  it('does not use known invalid particles after product terms', () => {
    const invalidParticles = [
      '런타임로',
      '저장소이',
      '저장소을',
      '환경로',
      '토큰를',
      '토큰는',
      '작업로',
      '마켓플레이스을',
      '마켓플레이스은',
      'Claude Code은',
      'Claude Code을',
      'opencode은',
      'opencode을',
      'Claude을',
      'ACP이',
      'SSH을',
      'SKILL.md을',
      '.ipynb을',
      'PDF은',
      'ZIP를',
      'ssh-agent을',
      '{{provider}}은'
    ]
    const offenders = Object.entries(catalog('ko')).flatMap(([key, value]) =>
      invalidParticles
        .filter((phrase) => value.includes(phrase))
        .map((phrase) => `${key}: ${phrase}`)
    )

    expect(offenders).toEqual([])
  })

  it('does not use known literal machine-translation phrasing', () => {
    const unnaturalPhrases = [
      '미리보기에 대한',
      '미리보기에 대해',
      '디렉토리',
      '보관처리',
      '저장 대화',
      '활성을 중지',
      '다른 것을 선택',
      '현재 데이터</em>과',
      '설명해주세요',
      '에이전트에 표시',
      'Open Science 스페셜리스트를',
      'Open Science 프로젝트를',
      'Open Science 커넥터를',
      'Open Science 스킬을',
      'Open Science는 커넥터를 로드',
      'Open Science는 스킬을 로드',
      'https://gateway.example/v1.와',
      '호출 커넥터 도구를 원합니다',
      '세션에 대해 에이전트를 중지',
      '스킬이 에이전트를 가르치는',
      '데이터를 어디에 저장해야 합니까',
      '이동에서 제거',
      '해당 폴더 없음',
      '자체 포함된',
      '대화 사용하시면',
      '지원되지 않음 파일',
      'Open Science 이',
      '모두 스페셜리스트',
      '대형 파일 (',
      '서브에이전트에서 사용됩니다',
      'Open Science 전체 현재 보기',
      '이 기존 검토에는 평가 세부정보',
      '스페셜리스트는 “',
      '새로고침할 수 없습니다 {{',
      '스페셜리스트에 구성됩니다',
      '미리보기 다시 시도해보세요',
      '이에 대한 자유 형식 메모 모델 제공업체',
      '에이전트 Open Science 드라이브',
      '스캔하여 열기 Open Science',
      '프록시 환경 Open Science',
      'protocol 뒤에',
      '<lnk>다운로드 Remote.It',
      '미리보기할 수',
      '대화에 대한 아티팩트',
      '{{target}}을(를)',
      '이것이 에이전트',
      '에 의해 별도로',
      '에 의해 예약',
      '운영 체제에 의해 암호화',
      '{{count}} 이 제한된',
      '{{count}} 이 미리보기',
      '{{count}} 단계를',
      '{{count}} 실패',
      '{{count}} 읽지 않음',
      '프로젝트 회복',
      '계속해서 회복',
      '생산자 운영',
      '페어링된 기본 Codex',
      '관리 쌍',
      '차단 유효성',
      '설치됨 스킬',
      '다음 조사 시',
      'NCBI 비율 제한',
      '선택 사항인 API 키'
    ]
    const offenders = Object.entries(catalog('ko')).flatMap(([key, value]) =>
      unnaturalPhrases
        .filter((phrase) => value.includes(phrase))
        .map((phrase) => `${key}: ${phrase}`)
    )

    expect(offenders).toEqual([])
  })

  it('uses Korean counters instead of English count-plus-noun order', () => {
    const bareCountedNoun =
      /\{\{count\}\}\s+(?:추가 단계|최종 결과|권한|스킬|모델|Notebook|패키지|스페셜리스트|에이전트|아티팩트|원자|셀|확인|환경 항목|수치|파일|발견 항목|결과|원격 작업|실행|세션|셸|서브에이전트|리소스)/u
    const offenders = Object.entries(catalog('ko'))
      .filter(([, value]) => bareCountedNoun.test(value))
      .map(([key]) => key)

    expect(offenders).toEqual([])
  })

  it('does not attach a fixed Korean particle directly to interpolated values', () => {
    const offenders = Object.entries(catalog('ko'))
      .filter(([, value]) => /\{\{[^{}]+\}\}(?:이|가|은|는|을|를|와|과)(?=[\s.,?!]|$)/u.test(value))
      .map(([key]) => key)

    expect(offenders).toEqual([])
  })

  it('uses the product role Reviewer consistently', () => {
    const offenders = Object.entries(catalog('ko'))
      .filter(([key]) => /\breviewer\b/i.test(englishOf(key)))
      .filter(([, value]) => !value.includes('리뷰어'))
      .map(([key]) => key)

    expect(offenders).toEqual([])
  })

  it('formats short examples as Korean UI placeholders', () => {
    const offenders = Object.entries(catalog('ko'))
      .filter(([key]) => /^e\.g\./i.test(englishOf(key)))
      .filter(([, value]) => !value.startsWith('예: '))
      .map(([key]) => key)

    expect(offenders).toEqual([])
  })

  it('uses GitHub issue terminology instead of the generic problem noun', () => {
    const offenders = Object.entries(catalog('ko'))
      .filter(([key]) => /GitHub issue/i.test(englishOf(key)))
      .filter(([, value]) => !value.includes('이슈'))
      .map(([key]) => key)

    expect(offenders).toEqual([])
  })

  it('preserves context-sensitive service and runtime terminology', () => {
    expect(catalog('ko')).toMatchObject({
      'Use {{service}}?': '{{service}} 서비스를 사용할까요?',
      'Context window chart across {{count}} terminal outcomes_other':
        '종료 결과 {{count}}개에 걸친 컨텍스트 창 차트'
    })
  })
})

describe('Korean binding terminology', () => {
  const mandatoryTerms: Array<{ source: RegExp; expected: string; stripSource?: RegExp }> = [
    { source: /\bprojects?\b/i, expected: '프로젝트' },
    { source: /\bsessions?\b/i, expected: '세션' },
    { source: /\bconversations?\b/i, expected: '대화' },
    { source: /\bworkspaces?\b/i, expected: '워크스페이스' },
    {
      source: /\bmessages?\b/i,
      expected: '메시지',
      stripSource: /\bMessages or Chat Completions\b/
    },
    { source: /\btasks?\b/i, expected: '작업' },
    { source: /\bmodels?\b/i, expected: '모델' },
    { source: /\bproviders?\b/i, expected: '모델 제공업체' },
    { source: /\bsubscriptions?\b/i, expected: '구독' },
    { source: /\bkernels?\b/i, expected: '커널' },
    { source: /\bartifacts?\b/i, expected: '아티팩트' },
    { source: /\bactivity groups?\b/i, expected: '활동 그룹' },
    { source: /\btools?\b/i, expected: '도구' },
    { source: /\bcompute hosts?\b/i, expected: '컴퓨팅 호스트' },
    { source: /\bruntimes?\b/i, expected: '런타임' },
    { source: /\benvironments?\b/i, expected: '환경' },
    { source: /\bpreviews?\b/i, expected: '미리보기' },
    { source: /\binterpreters?\b/i, expected: '인터프리터' },
    { source: /\breasoning effort\b/i, expected: '추론 강도' },
    { source: /\bcontexts?\b/i, expected: '컨텍스트' },
    { source: /\bfiles?\b/i, expected: '파일' },
    { source: /\bdocuments?\b/i, expected: '문서' },
    { source: /\bfolders?\b/i, expected: '폴더' },
    { source: /\bdata\b/i, expected: '데이터' },
    { source: /\binformation\b/i, expected: '정보' },
    { source: /\bsoftware\b/i, expected: '소프트웨어' },
    { source: /\bprograms?\b/i, expected: '프로그램' },
    { source: /\bsettings?\b/i, expected: '설정' },
    { source: /\bnetworks?\b/i, expected: '네트워크' },
    { source: /\bcaches?\b/i, expected: '캐시' },
    { source: /\bprocess(?:es)?\b/i, expected: '프로세스' },
    { source: /\bthreads?\b/i, expected: '스레드' },
    { source: /\bqueues?\b/i, expected: '대기열' },
    { source: /\bcredentials?\b/i, expected: '자격 증명' },
    { source: /\blogs?\b/i, expected: '로그' },
    { source: /\bmirrors?\b/i, expected: '미러' },
    { source: /\btrays?\b/i, expected: '트레이' },
    { source: /\bbookmarks?\b/i, expected: '북마크' },
    { source: /\brunning\b/i, expected: '실행 중', stripSource: /\bby running\b/i },
    { source: /\bcalls?\b/i, expected: '호출' },
    { source: /\breveal(?:s|ed|ing)?\b/i, expected: '표시' },
    { source: /\blight\b/i, expected: '라이트' },
    { source: /\bdark\b/i, expected: '다크' }
  ]

  it.each(mandatoryTerms)(
    'uses $expected for matching source prose',
    ({ source, expected, stripSource }) => {
      const offenders = Object.entries(catalog('ko'))
        .filter(([key]) => {
          const sourceText = englishOf(key)
            .replace(/<code>.*?<\/code>/g, '')
            .replace(/\{\{\w+\}\}|<\/?\w+>|https?:\/\/\S+|\b[A-Za-z]:\\[\w.\\-]*(?<!\.)/g, '')
          return source.test(stripSource ? sourceText.replace(stripSource, '') : sourceText)
        })
        .filter(([, value]) => !value.includes(expected))
        .map(([key]) => key)

      expect(offenders).toEqual([])
    }
  )

  it('matches topic, object, and conjunction particles to the chosen term', () => {
    const hasFinalConsonant = (term: string): boolean => {
      const last = [...term].at(-1)
      if (!last) return false
      const codePoint = last.codePointAt(0) ?? 0
      return codePoint >= 0xac00 && codePoint <= 0xd7a3 && (codePoint - 0xac00) % 28 !== 0
    }
    const offenders = [...new Set(mandatoryTerms.map(({ expected }) => expected))].flatMap(
      (term) => {
        const wrongParticles = hasFinalConsonant(term) ? ['는', '를', '와'] : ['은', '을', '과']
        const pattern = new RegExp(`${term}(?:${wrongParticles.join('|')})(?=\\s|[,.!?…<]|$)`, 'u')
        return Object.entries(catalog('ko'))
          .filter(([, value]) => pattern.test(value))
          .map(([key]) => `${key}: ${term}`)
      }
    )

    expect(offenders).toEqual([])
  })

  it.each([
    ['Allow for this conversation', '이 대화에서 허용'],
    ['Allowed this session', '이번 세션에서 허용됨'],
    [
      'Approval applies to matching calls in this project.',
      '이 프로젝트에서 일치하는 호출에 승인이 적용됩니다.'
    ],
    [
      'Approval covers later {{runtime}} calls in this conversation, including across restarts.',
      '승인은 다시 시작 후에도 이 대화에서 이후 {{runtime}} 호출에 적용됩니다.'
    ],
    ['made a call', '호출 실행'],
    ['Plan call record', '계획 호출 기록'],
    ['Resume', '재개'],
    ['Resume session', '세션 재개'],
    ['Running', '실행 중'],
    ['running', '실행 중'],
    ['Reveal in folder', '폴더에 표시'],
    ['Light', '라이트'],
    ['Dark', '다크'],
    ['Storage', '저장소'],
    ['Archive', '보관'],
    ['Approve', '허용'],
    ['Retry', '다시 시도'],
    ['Idle', '대기 중'],
    ['Completed', '완료'],
    ['Refreshing…', '새로고침 중…'],
    ['Application storage', '애플리케이션 저장소'],
    ['Anthropic approx.', 'Anthropic 근사치'],
    ['Chromium v', 'Chromium v'],
    ['Add interpreter…', '인터프리터 추가…'],
    ['Could not add that interpreter.', '해당 인터프리터를 추가할 수 없습니다.'],
    [
      'Enable the environments each notebook language may run in. The app-managed environment is on by default; enable your own interpreters to make them available to the agent.',
      '각 Notebook 언어가 실행될 수 있는 환경을 활성화합니다. 앱 관리 환경은 기본적으로 켜져 있습니다. 에이전트가 사용할 수 있도록 자체 인터프리터를 활성화하세요.'
    ],
    ['Token usage for this response', '이 응답의 토큰 사용량'],
    ['Token usage unavailable for this response', '이 응답의 토큰 사용량을 확인할 수 없습니다.'],
    ['Used tool: {{name}}', '사용한 도구: {{name}}'],
    ['read a file', '파일 읽음'],
    ['ran {{count}} tools_other', '도구 {{count}}개 실행'],
    ['Keep it in the current folder', '현재 폴더에 유지'],
    ['Pin current folder', '현재 폴더 고정'],
    ['Load more sessions', '세션 더 불러오기'],
    ['for this project', '이 프로젝트에서'],
    ['globally', '모든 프로젝트에서'],
    ['Allow {{subject}} {{scope}}?', '{{scope}} {{subject}} 사용을 허용하시겠습니까?'],
    [
      'Skills and connectors this specialist can use. Anything not chosen here stays invisible and unreachable in its sessions, even when enabled globally.',
      '이 스페셜리스트가 사용할 수 있는 스킬과 커넥터입니다. 여기에서 선택하지 않은 항목은 전역으로 활성화되어 있어도 해당 세션에서 보이지 않으며 접근할 수 없습니다.'
    ],
    ['Move to OpenScience', 'OpenScience로 이동'],
    ['Official install.ps1', '공식 install.ps1'],
    [
      'One <code>Name: Value</code> per line (not JSON).',
      '줄마다 <code>Name: Value</code> 하나씩 입력하세요(JSON 형식 아님).'
    ],
    [
      'Used by host.mcp("{{name}}", …), Specialists, and the generated MCP skill.',
      'host.mcp("{{name}}", …), 스페셜리스트 및 생성된 MCP 스킬에서 사용됩니다.'
    ],
    [
      'Two-step verification uses a six-digit code. Approve a new remote session only when its code matches the request shown here.',
      '2단계 인증은 6자리 코드를 사용합니다. 코드가 여기에 표시된 요청과 일치할 때만 새 원격 세션을 승인하세요.'
    ],
    ['Library', '라이브러리'],
    ['{{count}} jobs_other', '작업 {{count}}개'],
    ['{{count}} repl_other', 'REPL {{count}}개'],
    ['{{count}} steps_other', '{{count}}단계'],
    ['{{count}} turns_other', '{{count}}턴'],
    [
      'Sending this edited prompt starts a new branch from here. The {{count}} turns that currently follow remain available from the message revision controls._other',
      '이 편집된 프롬프트를 보내면 여기에서 새 브랜치가 시작됩니다. 현재 뒤따르는 {{count}}개 턴은 메시지 수정 컨트롤에서 계속 사용할 수 있습니다.'
    ],
    [
      'Saved conversations loaded, but the project index could not be rebuilt. Repair the index before archiving projects.',
      '저장된 대화는 로드되었지만 프로젝트 색인을 다시 빌드할 수 없습니다. 프로젝트를 보관하기 전에 색인을 복구하세요.'
    ],
    [
      'Some saved conversations could not be indexed. Repair the index before archiving projects.',
      '일부 저장된 대화의 색인을 생성할 수 없습니다. 프로젝트를 보관하기 전에 색인을 복구하세요.'
    ],
    [
      'Project archive is unavailable because a damaged conversation cannot be verified.',
      '손상된 대화를 확인할 수 없어 프로젝트 보관 기능을 사용할 수 없습니다.'
    ],
    ['Star', '별표'],
    [
      'Choose one .json file up to {{size}}. Credential values are never imported from the file.',
      '최대 {{size}}인 .json 파일 하나를 선택하세요. 파일에서 자격 증명 값은 가져오지 않습니다.'
    ],
    ['Star on GitHub', 'GitHub에서 Star'],
    ['Star {{app}} on GitHub', 'GitHub에서 {{app}}에 Star'],
    [
      'Star {{app}} on GitHub, {{count}} stars_other',
      'GitHub에서 {{app}}에 Star, Star {{count}}개'
    ],
    [
      "Conversations still bound to <name>{{name}}</name> will become <em>unavailable</em> and will <em>not</em> be switched to Main Agent automatically. For each affected conversation you'll explicitly choose a new specialist or Main Agent before it can send again.",
      '<name>{{name}}</name>에 계속 연결된 대화는 <em>사용할 수 없게</em> 되며 메인 에이전트로 자동 <em>전환되지 않습니다</em>. 영향을 받는 각 대화가 다시 메시지를 보내기 전에 새 스페셜리스트 또는 메인 에이전트를 명시적으로 선택해야 합니다.'
    ]
  ])('preserves the exact meaning of %s', (key, expected) => {
    expect(catalog('ko')[key]).toBe(expected)
  })

  it('does not use known non-UI senses for ambiguous English words', () => {
    const forbidden = [
      '선택 과목',
      '다른 가족',
      '가까운 출처',
      '수표',
      '장애인',
      '항구',
      '요금제 세부정보',
      '작곡가',
      '회전 제한',
      '단어 분석 문서',
      '일하는 중'
    ]
    const offenders = Object.entries(catalog('ko'))
      .filter(([, value]) => forbidden.some((term) => value.includes(term)))
      .map(([key]) => key)

    expect(offenders).toEqual([])
  })
})

describe('Russian safety copy', () => {
  it.each([
    ['Allow globally', 'Разрешить глобально'],
    ['Approval applies to this call only.', 'Разрешение действует только для этого вызова.'],
    ['This call only', 'Только этот вызов'],
    [
      'Individual grants remain revocable; Revoke all is disabled until the complete set is known.',
      'Отдельные разрешения по-прежнему можно отзывать; действие «Отозвать все» недоступно, пока не известен полный набор.'
    ],
    [
      'This message snapshot was created by a newer version of Open Science. Update the app to view it.',
      'Этот снимок сообщения создан в более новой версии Open Science. Обновите приложение, чтобы его просмотреть.'
    ]
  ])('preserves the scope of %s', (key, expected) => {
    expect(catalog('ru')[key]).toBe(expected)
  })
})

describe('French safety copy', () => {
  it.each([
    ['Allow globally', 'Autoriser pour tous les projets'],
    ['-y @modelcontextprotocol/server-memory', '-y @modelcontextprotocol/server-memory'],
    ['*.internal.example, 10.0.0.0/8', '*.internal.example, 10.0.0.0/8'],
    ['Approval applies to this call only.', "L'autorisation s'applique uniquement à cet appel."],
    ['This call only', 'Pour cet appel uniquement'],
    [
      'Individual grants remain revocable; Revoke all is disabled until the complete set is known.',
      "Les autorisations individuelles restent révocables\u00a0; « Tout révoquer » est désactivé tant que l'ensemble complet n'est pas connu."
    ],
    ['{{count}} allowed this session_one', '{{count}} autorisation accordée pendant cette session'],
    [
      '{{count}} allowed this session_other',
      '{{count}} autorisations accordées pendant cette session'
    ]
  ])('preserves the scope of %s', (key, expected) => {
    expect(catalog('fr')[key]).toBe(expected)
  })

  it.each([
    ['Session', 'Session'],
    ['Sessions', 'Sessions'],
    ['{{count}} sessions_one', '{{count}} session'],
    ['{{count}} sessions_other', '{{count}} sessions'],
    ['{{count}} runs_one', '{{count}} exécution'],
    ['{{count}} runs_other', '{{count}} exécutions'],
    ['{{count}} packages_one', '{{count}} paquet'],
    ['{{count}} packages_other', '{{count}} paquets'],
    ['{{count}} checks_one', '{{count}} vérification'],
    ['{{count}} checks_other', '{{count}} vérifications'],
    ['{{count}} files_one', '{{count}} fichier'],
    ['{{count}} files_other', '{{count}} fichiers'],
    ['Runs', 'Exécutions'],
    ['Checks', 'Vérifications'],
    ['Package', 'Paquet'],
    ['Packages', 'Paquets'],
    ['Download Plan', 'Télécharger le plan'],
    ['Plan blocked', 'Plan bloqué'],
    ['Revoked {{count}} permissions_one', '{{count}} autorisation révoquée'],
    ['Revoked {{count}} permissions_other', '{{count}} autorisations révoquées']
  ])('uses French domain terminology and plural agreement for %s', (key, expected) => {
    expect(catalog('fr')[key]).toBe(expected)
  })

  it('never translates the product term Session as a meeting', () => {
    const offenders = Object.entries(catalog('fr'))
      .filter(([key]) => /\bsessions?\b/i.test(englishOf(key)))
      .filter(([, value]) => /\bséances?\b/i.test(value))
      .map(([key]) => key)

    expect(offenders).toEqual([])
  })

  it('does not leave generic package prose in English or translate Plan as a pricing tier', () => {
    const proseOnly = (value: string): string =>
      value.replace(/\b[\w.-]+\.(?:md|txt|json|zip)\b/g, '')
    const offenders = Object.entries(catalog('fr'))
      .filter(([key]) => /\b(?:packages?|Plan)\b/.test(proseOnly(englishOf(key))))
      .filter(([, value]) => /\b(?:packages?|forfaits?)\b/i.test(proseOnly(value)))
      .map(([key]) => key)

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
      'inUse',
      'theme',
      'language',
      'runtime'
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
const resolvesIn = (
  entries: Catalog,
  { key, plural, context }: CallSite,
  pluralCategories: readonly string[] = ['other']
): boolean => {
  if (context) {
    if (plural) {
      return pluralCategories.every(
        (category) => entries[`${key}_${context}_${category}`] !== undefined
      )
    }
    return entries[`${key}_${context}`] !== undefined
  }
  if (plural) return pluralCategories.every((c) => entries[`${key}_${c}`] !== undefined)
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
      .filter((site) => !resolvesIn(entries, site, REQUIRED_PLURAL_CATEGORIES[locale]))
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
  'alt',
  'hint'
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

  it('finds bare copy in a user-visible custom hint prop', () => {
    expect(bareAttributeValues('<MenuRadioItem hint="provider default" />')).toEqual([
      { text: 'provider default', line: 1 }
    ])
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
