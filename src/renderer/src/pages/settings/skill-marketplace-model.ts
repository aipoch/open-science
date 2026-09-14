import type { SkillMarketplaceEntry } from '../../../../shared/skill-marketplace'
export {
  skillMarketplaceCategories,
  skillMarketplaceRepository,
  type SkillMarketplaceEntry
} from '../../../../shared/skill-marketplace'
export const SKILL_MARKETPLACE_PAGE_SIZE = 36

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
        ...(item.authors?.map((a) => a.name) ?? [])
      ].some((value) => value?.toLocaleLowerCase(locale).includes(term))
  )
  return sort === 'name'
    ? matches.sort((a, b) => a.displayName.localeCompare(b.displayName, locale))
    : matches
}
