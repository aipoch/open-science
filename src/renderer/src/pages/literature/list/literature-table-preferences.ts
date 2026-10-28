export type LiteratureTableColumn =
  | `journal:${string}`
  | 'abstract'
  | 'authors'
  | 'notes'
  | 'publication'
  | 'readingStatus'
  | 'rating'
  | 'tags'
  | 'type'
  | 'url'
  | 'year'

const literatureTableColumns = [
  'readingStatus',
  'abstract',
  'year',
  'publication',
  'authors',
  'type',
  'tags',
  'rating',
  'notes',
  'url'
] as const satisfies readonly LiteratureTableColumn[]

const defaultLiteratureTableColumns = literatureTableColumns.filter(
  (column) => column !== 'abstract' && column !== 'notes' && column !== 'url'
)

export const literatureTableColumnWidths: Record<LiteratureTableColumn, number> = {
  readingStatus: 144,
  type: 160,
  authors: 224,
  year: 80,
  publication: 224,
  tags: 208,
  abstract: 320,
  rating: 152,
  notes: 280,
  url: 80
}

export const LITERATURE_TABLE_PREFERENCES_KEY = 'open-science:literature-table-preferences'

type LiteratureTablePreferences = Readonly<{
  order: LiteratureTableColumn[]
  visible: LiteratureTableColumn[]
}>

const isLiteratureTableColumn = (value: unknown): value is LiteratureTableColumn =>
  typeof value === 'string' &&
  ((literatureTableColumns as readonly string[]).includes(value) || value.startsWith('journal:'))

export const loadLiteratureTablePreferences = (): LiteratureTablePreferences => {
  const fallback = {
    order: [...literatureTableColumns],
    visible: [...defaultLiteratureTableColumns]
  }
  try {
    const stored = window.localStorage.getItem(LITERATURE_TABLE_PREFERENCES_KEY)
    if (!stored) return fallback
    const parsed = JSON.parse(stored) as { order?: unknown; visible?: unknown }
    const storedOrder = Array.isArray(parsed.order)
      ? parsed.order.filter(isLiteratureTableColumn)
      : []
    const readingStatusAdded = !storedOrder.includes('readingStatus')
    const order = [
      ...new Set<LiteratureTableColumn>([
        ...(readingStatusAdded ? (['readingStatus'] as const) : []),
        ...storedOrder,
        ...literatureTableColumns.filter((column) => !storedOrder.includes(column))
      ])
    ]
    const visible = Array.isArray(parsed.visible)
      ? parsed.visible.filter(isLiteratureTableColumn)
      : fallback.visible
    if (readingStatusAdded && !visible.includes('readingStatus')) visible.push('readingStatus')
    return { order, visible }
  } catch {
    return fallback
  }
}
