import { codeBuddySiteForId } from '../../../../shared/codebuddy-subscription'
import { getOfficialVendor, type OfficialVendorId } from '@aipoch/providers'

import {
  LOCAL_MODEL_KIND_PREFIX,
  LOCAL_MODEL_PRESETS,
  PROVIDER_KINDS,
  isProviderKindAvailable,
  type ProviderKind,
  type ProviderKindAvailability
} from './provider-form-value'

// Sections of the Add provider picker, in display order. The custom gateway sits above them all.
export type ProviderPickerCategory =
  'sign-in' | 'vendor' | 'coding-plan' | 'cloud' | 'gateway' | 'local'

export const PROVIDER_PICKER_CATEGORIES: readonly ProviderPickerCategory[] = [
  'sign-in',
  'vendor',
  'coding-plan',
  'cloud',
  'gateway',
  'local'
]

// Vendors in picker display order. A new registry vendor must be filed under a section.
const VENDOR_CATEGORY: Record<
  OfficialVendorId,
  Exclude<ProviderPickerCategory, 'sign-in' | 'local'>
> = {
  openai: 'vendor',
  anthropic: 'vendor',
  xai: 'vendor',
  apodex: 'vendor',
  deepseek: 'vendor',
  zhipu: 'vendor',
  kimi: 'vendor',
  minimax: 'vendor',
  stepfun: 'vendor',
  xiaomimimo: 'vendor',
  sensenova: 'vendor',
  'opencode-go': 'coding-plan',
  glmcodingplan: 'coding-plan',
  kimiforcode: 'coding-plan',
  bailianplan: 'coding-plan',
  stepplan: 'coding-plan',
  tencentcodingplan: 'coding-plan',
  tencenttokenplan: 'coding-plan',
  bailian: 'cloud',
  volcengine: 'cloud',
  tencent: 'cloud',
  nvidia: 'cloud',
  opencode: 'gateway',
  openrouter: 'gateway',
  requesty: 'gateway',
  kilo: 'gateway'
}

// Unlisted sign-ins keep their relative order before xAI. The picker pins Custom separately.
const pickerOrder = [
  'xai-subscription',
  ...Object.keys(VENDOR_CATEGORY).map((id) => `official:${id}`)
]
const pickerKinds = [...PROVIDER_KINDS].sort(
  (left, right) => pickerOrder.indexOf(left.key) - pickerOrder.indexOf(right.key)
)

// Extra search terms for names users commonly type instead of the registry label: local-language
// brand names, product names, and model families. Matching only; never displayed.
const VENDOR_SEARCH_ALIASES: Partial<Record<OfficialVendorId, readonly string[]>> = {
  openai: ['gpt', 'chatgpt'],
  anthropic: ['claude'],
  xai: ['grok'],
  deepseek: ['深度求索'],
  bailian: ['百炼', '阿里云', '阿里雲', 'alibaba', 'aliyun', 'dashscope', 'qwen', '通义', '千问'],
  bailianplan: ['百炼', '阿里云', '阿里雲', 'alibaba', 'aliyun', 'qwen', 'coding plan'],
  zhipu: ['智谱', '智譜', 'glm', 'bigmodel', 'z.ai'],
  glmcodingplan: ['智谱', '智譜', 'glm', 'bigmodel', 'z.ai'],
  kimi: ['月之暗面', 'moonshot'],
  kimiforcode: ['月之暗面', 'moonshot'],
  minimax: ['海螺'],
  stepfun: ['阶跃', '階躍'],
  stepplan: ['阶跃', '階躍', 'stepfun'],
  xiaomimimo: ['小米', 'xiaomi', 'mimo'],
  sensenova: ['商汤', '商湯', '日日新', 'sensetime'],
  volcengine: ['火山引擎', '火山', '豆包', 'doubao', 'ark', 'bytedance', '字节'],
  tencent: ['腾讯', '騰訊', '混元', 'hunyuan'],
  tencentcodingplan: ['腾讯', '騰訊', '混元', 'hunyuan'],
  tencenttokenplan: ['腾讯', '騰訊', '混元', 'hunyuan']
}

export type ProviderPickerEntry<Key extends string = string> = {
  // Provider kind key the form is seeded from (see providerKindPatch).
  key: Key
  iconKey?: string
  // A custom gateway is pinned above the sections rather than filed under one.
  category: ProviderPickerCategory | 'custom'
  // Proper nouns pass through; kinds with a labelKey are translated by the picker.
  kind?: ProviderKind
  label?: string
  // Console or endpoint host shown under the name, e.g. platform.deepseek.com.
  host?: string
  regionCount?: number
  disabled: boolean
  searchText: string
}

const hostOf = (url: string | undefined): string | undefined => {
  if (!url) return undefined
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return undefined
  }
}

const normalize = (text: string): string => text.toLowerCase().replace(/\s+/g, '')

const vendorEntry = (kind: ProviderKind, vendorId: OfficialVendorId): ProviderPickerEntry => {
  const vendor = getOfficialVendor(vendorId)
  const regions = vendor?.regions ?? []
  const urls = [
    vendor?.apiKeyUrl,
    vendor?.baseUrl,
    vendor?.chatCompletionsBaseUrl,
    ...regions.flatMap((region) => [region.apiKeyUrl, region.baseUrl])
  ]
  const hosts = urls.map(hostOf).filter((host): host is string => Boolean(host))

  return {
    key: kind.key,
    category: VENDOR_CATEGORY[vendorId],
    kind,
    host: hosts[0],
    regionCount: regions.length > 1 ? regions.length : undefined,
    disabled: false,
    searchText: normalize(
      [kind.label ?? '', vendorId, ...hosts, ...(VENDOR_SEARCH_ALIASES[vendorId] ?? [])].join(' ')
    )
  }
}

// Every provider kind the Add provider picker offers for the active framework, in display order
// within each section. Search text is precomputed; labels from the catalog are matched by the
// picker after translation.
export const providerPickerEntries = (
  availability: ProviderKindAvailability
): ProviderPickerEntry[] => {
  const entries: ProviderPickerEntry[] = []

  for (const kind of pickerKinds) {
    if (!isProviderKindAvailable(kind, availability)) continue
    if (kind.key.startsWith('official:')) {
      entries.push(vendorEntry(kind, kind.key.slice('official:'.length) as OfficialVendorId))
      continue
    }
    entries.push({
      key: kind.key,
      category: kind.key === 'custom' ? 'custom' : 'sign-in',
      kind,
      disabled: Boolean(
        codeBuddySiteForId(kind.key) && availability.codeBuddyProviders?.includes(kind.key)
      ),
      searchText: normalize(
        [
          kind.label ?? kind.labelKey,
          kind.key,
          kind.key === 'custom' ? 'openai anthropic compatible' : ''
        ].join(' ')
      )
    })
  }

  for (const preset of LOCAL_MODEL_PRESETS) {
    const host = hostOf(preset.baseUrl)
    entries.push({
      key: `${LOCAL_MODEL_KIND_PREFIX}${preset.id}`,
      category: 'local',
      label: preset.label,
      host,
      disabled: false,
      searchText: normalize([preset.label, preset.id, host ?? '', 'local'].join(' '))
    })
  }

  return entries
}

// Case- and whitespace-insensitive substring match against the entry's names, hosts and aliases,
// plus the translated label the user actually sees.
export const matchesProviderPickerQuery = (
  entry: ProviderPickerEntry,
  query: string,
  displayLabel: string
): boolean => {
  const needle = normalize(query)
  if (!needle) return true
  return entry.searchText.includes(needle) || normalize(displayLabel).includes(needle)
}
