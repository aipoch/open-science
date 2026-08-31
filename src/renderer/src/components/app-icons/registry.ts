import {
  Archive,
  Atom,
  Beaker,
  BookOpen,
  Bot,
  Brain,
  Briefcase,
  Bug,
  Calculator,
  Camera,
  ChartColumn,
  ChartScatter,
  ChefHat,
  CircuitBoard,
  ClipboardCheck,
  Cloud,
  CodeXml,
  Compass,
  Cpu,
  Database,
  Dna,
  DraftingCompass,
  Feather,
  FlaskConical,
  GitBranch,
  Globe,
  GraduationCap,
  HardHat,
  Landmark,
  Languages,
  LibraryBig,
  Lightbulb,
  Magnet,
  Microscope,
  Music,
  Network,
  NotebookPen,
  Palette,
  PawPrint,
  PenTool,
  Pill,
  Presentation,
  Quote,
  Radar,
  Rocket,
  Satellite,
  Scale,
  ScrollText,
  Search,
  Server,
  ShieldCheck,
  Sigma,
  Sprout,
  SquareTerminal,
  Stethoscope,
  Syringe,
  Telescope,
  TestTubes,
  Thermometer,
  Waves,
  Workflow,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import { MoleculeIcon, PetriDishIcon } from './custom-glyphs'

// Shared app icon registry: the single source of truth for the small stroke-style icon
// set ("logos") used by Specialist avatars and reusable by any future surface. Prefer a
// Lucide export when one fits; add a hand-drawn glyph in ./custom-glyphs otherwise.
//
// Icons are chosen to read as a Specialist's identity (a role or discipline), not as
// app features. Icon keys are persisted (e.g. SpecialistView.iconKey) and must
// never be renamed or removed; unknown keys resolve to DEFAULT_APP_ICON. Labels are
// i18n keys: render them through t(entry.label) — every label needs catalog entries in
// de / es / fr / ja / ko / ru / zh-Hans / zh-Hant (the English literal below anchors the
// orphan guard).
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
      { key: 'molecule', label: 'Molecule', Icon: MoleculeIcon },
      { key: 'test-tubes', label: 'Test tubes', Icon: TestTubes },
      { key: 'sprout', label: 'Sprout', Icon: Sprout },
      { key: 'pill', label: 'Pill', Icon: Pill },
      { key: 'syringe', label: 'Syringe', Icon: Syringe },
      { key: 'magnet', label: 'Magnet', Icon: Magnet },
      { key: 'satellite', label: 'Satellite', Icon: Satellite },
      { key: 'waves', label: 'Waves', Icon: Waves },
      { key: 'thermometer', label: 'Thermometer', Icon: Thermometer }
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
      { key: 'feather', label: 'Quill', Icon: Feather },
      { key: 'library-big', label: 'Librarian', Icon: LibraryBig },
      { key: 'scroll-text', label: 'Manuscript', Icon: ScrollText },
      { key: 'quote', label: 'Citation', Icon: Quote },
      { key: 'pen-tool', label: 'Writer', Icon: PenTool },
      { key: 'clipboard-check', label: 'Protocol', Icon: ClipboardCheck },
      { key: 'chart-scatter', label: 'Scatter plot', Icon: ChartScatter },
      { key: 'archive', label: 'Archivist', Icon: Archive },
      { key: 'landmark', label: 'Landmark', Icon: Landmark }
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
      { key: 'compass', label: 'Guide', Icon: Compass },
      { key: 'drafting-compass', label: 'Architect', Icon: DraftingCompass },
      { key: 'languages', label: 'Translator', Icon: Languages },
      { key: 'paw-print', label: 'Veterinarian', Icon: PawPrint },
      { key: 'chef-hat', label: 'Chef', Icon: ChefHat },
      { key: 'hard-hat', label: 'Builder', Icon: HardHat },
      { key: 'wrench', label: 'Mechanic', Icon: Wrench },
      { key: 'camera', label: 'Photographer', Icon: Camera },
      { key: 'music', label: 'Musician', Icon: Music }
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
      { key: 'database', label: 'Data', Icon: Database },
      { key: 'cpu', label: 'Chip', Icon: Cpu },
      { key: 'circuit-board', label: 'Electronics', Icon: CircuitBoard },
      { key: 'server', label: 'Server', Icon: Server },
      { key: 'network', label: 'Network', Icon: Network },
      { key: 'git-branch', label: 'Git', Icon: GitBranch },
      { key: 'workflow', label: 'Pipeline', Icon: Workflow },
      { key: 'radar', label: 'Radar', Icon: Radar },
      { key: 'cloud', label: 'Cloud', Icon: Cloud }
    ]
  }
]

export const APP_ICONS: Record<string, LucideIcon> = Object.fromEntries(
  APP_ICON_GROUPS.flatMap((group) => group.icons.map((icon) => [icon.key, icon.Icon]))
)

export const DEFAULT_APP_ICON = Brain
