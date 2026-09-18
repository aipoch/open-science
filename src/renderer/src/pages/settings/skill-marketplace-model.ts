import type { SkillMarketplaceEntry } from '../../../../shared/skill-marketplace'
export {
  skillMarketplaceCategories,
  skillMarketplaceRepository,
  type SkillMarketplaceEntry
} from '../../../../shared/skill-marketplace'
export const SKILL_MARKETPLACE_PAGE_SIZE = 36

export function skillMarketplaceSourceOwner(item: SkillMarketplaceEntry): string {
  // The verified catalog restricts source repositories to https://github.com/<owner>/<repo>.
  // Keep repository ownership separate from authorship and the package publisher.
  return new URL(item.source.repository).pathname.split('/')[1]
}

export function skillMarketplaceAttribution(item: SkillMarketplaceEntry): string {
  return item.authors?.map((author) => author.name).join(', ') || skillMarketplaceSourceOwner(item)
}

export function filterSkillMarketplace(
  items: readonly SkillMarketplaceEntry[],
  query: string,
  category: string,
  sort: string,
  locale: string
): SkillMarketplaceEntry[] {
  const term = query.trim().toLocaleLowerCase(locale)
  const matches = items.filter(
    (item) =>
      (category === 'all' || item.category === category) &&
      [
        item.id,
        item.displayName,
        item.summary,
        item.category,
        skillMarketplaceSourceOwner(item),
        ...(item.authors?.map((a) => a.name) ?? [])
      ].some((value) => value?.toLocaleLowerCase(locale).includes(term))
  )
  return sort === 'name'
    ? matches.sort((a, b) => a.displayName.localeCompare(b.displayName, locale))
    : matches
}
