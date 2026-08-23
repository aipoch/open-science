import {
  Atom,
  Beaker,
  BookOpen,
  Bot,
  Brain,
  Briefcase,
  Bug,
  Calculator,
  ChartColumn,
  CodeXml,
  Compass,
  Database,
  Dna,
  Feather,
  FlaskConical,
  Globe,
  GraduationCap,
  Lightbulb,
  Microscope,
  NotebookPen,
  Palette,
  Presentation,
  Rocket,
  Scale,
  Search,
  ShieldCheck,
  Sigma,
  SquareTerminal,
  Stethoscope,
  Telescope,
  type LucideIcon
} from 'lucide-react'
import { MoleculeIcon, OwlScholarIcon, PetriDishIcon } from './custom-glyphs'

// Shared app icon registry: the single source of truth for the small stroke-style icon
// set ("logos") used by Specialist avatars and reusable by any future surface. Prefer a
// Lucide export when one fits; add a hand-drawn glyph in ./custom-glyphs otherwise.
//
// Icons are chosen to read as a Specialist's identity (a role or discipline), not as
// app features. Icon keys are persisted (e.g. SpecialistProfileView.iconKey) and must
// never be renamed or removed; unknown keys resolve to DEFAULT_APP_ICON. Labels are
// i18n keys: render them through t(entry.label) — every label needs catalog entries in
// zh-Hans / zh-Hant / ja / ko (the English literal below anchors the orphan guard).
export type AppIconEntry = { key: string; label: string; Icon: LucideIcon }
export type AppIconGroup = { key: string; label: string; icons: readonly AppIconEntry[] }

export const APP_ICON_GROUPS: readonly AppIconGroup[] = [
  {
    key: 'science',
    label: 'Science',
    icons: [
      { key: 'brain', label: 'Brain', Icon: Brain },
      { key: 'beaker', label: 'Beaker', Icon: Beaker },
      { key: 'flask-conical', label: 'Flask', Icon: FlaskConical },
      { key: 'microscope', label: 'Microscope', Icon: Microscope },
      { key: 'atom', label: 'Atom', Icon: Atom },
      { key: 'dna', label: 'DNA', Icon: Dna },
      { key: 'petri-dish', label: 'Petri dish', Icon: PetriDishIcon },
      { key: 'molecule', label: 'Molecule', Icon: MoleculeIcon }
    ]
  },
  {
    key: 'research',
    label: 'Research',
    icons: [
      { key: 'book-open', label: 'Book', Icon: BookOpen },
      { key: 'search', label: 'Search', Icon: Search },
      { key: 'telescope', label: 'Telescope', Icon: Telescope },
      { key: 'lightbulb', label: 'Idea', Icon: Lightbulb },
      { key: 'graduation-cap', label: 'Scholar', Icon: GraduationCap },
      { key: 'notebook-pen', label: 'Notes', Icon: NotebookPen },
      { key: 'feather', label: 'Quill', Icon: Feather }
    ]
  },
  {
    key: 'roles',
    label: 'Roles',
    icons: [
      { key: 'stethoscope', label: 'Clinician', Icon: Stethoscope },
      { key: 'scale', label: 'Legal', Icon: Scale },
      { key: 'briefcase', label: 'Business', Icon: Briefcase },
      { key: 'palette', label: 'Designer', Icon: Palette },
      { key: 'presentation', label: 'Teacher', Icon: Presentation },
      { key: 'calculator', label: 'Accountant', Icon: Calculator },
      { key: 'bug', label: 'Reviewer', Icon: Bug },
      { key: 'compass', label: 'Guide', Icon: Compass }
    ]
  },
  {
    key: 'engineering',
    label: 'Engineering',
    icons: [
      { key: 'code-xml', label: 'Code', Icon: CodeXml },
      { key: 'square-terminal', label: 'Terminal', Icon: SquareTerminal },
      { key: 'bot', label: 'Bot', Icon: Bot },
      { key: 'rocket', label: 'Rocket', Icon: Rocket },
      { key: 'globe', label: 'Globe', Icon: Globe },
      { key: 'shield-check', label: 'Shield', Icon: ShieldCheck },
      { key: 'chart-column', label: 'Analyst', Icon: ChartColumn },
      { key: 'sigma', label: 'Statistician', Icon: Sigma },
      { key: 'database', label: 'Data', Icon: Database }
    ]
  }
]

export const APP_ICONS: Record<string, LucideIcon> = {
  ...Object.fromEntries(
    APP_ICON_GROUPS.flatMap((group) => group.icons.map((icon) => [icon.key, icon.Icon]))
  ),
  // Fixed system identity; intentionally excluded from the user-facing appearance picker.
  'owl-scholar': OwlScholarIcon
}

export const DEFAULT_APP_ICON = Brain
