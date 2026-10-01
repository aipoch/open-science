import { Hash, List, ListChecks, Type, type LucideIcon } from 'lucide-react'
import type { JournalField } from '../../../../shared/journal-attributes'
export const journalFieldKindIcons: Record<JournalField['kind'], LucideIcon> = {
  text: Type,
  number: Hash,
  singleSelect: List,
  multiSelect: ListChecks
}
