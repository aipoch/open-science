import {
  Atom,
  BookOpen,
  Dna,
  File,
  FileArchive,
  FileCode2,
  FileCog,
  FileImage,
  FileJson,
  FilePenLine,
  FileSpreadsheet,
  FileText,
  FileTerminal,
  FileType2,
  Presentation,
  Sigma,
  VectorSquare,
  type LucideIcon
} from 'lucide-react'

import { cn } from '@/lib/utils'

import { getFileIconKind, type FileIconKind } from './file-type-icon-kind'

const FILE_ICON_PRESENTATION: Record<FileIconKind, { Icon: LucideIcon; color: string }> = {
  archive: { Icon: FileArchive, color: 'text-text-300' },
  code: { Icon: FileCode2, color: 'text-text-300' },
  config: { Icon: FileCog, color: 'text-text-300' },
  data: { Icon: FileJson, color: 'text-text-300' },
  document: { Icon: FilePenLine, color: 'text-text-300' },
  image: { Icon: FileImage, color: 'text-text-300' },
  molecule: { Icon: Atom, color: 'text-text-300' },
  notebook: { Icon: BookOpen, color: 'text-text-300' },
  pdf: { Icon: FileType2, color: 'text-text-300' },
  presentation: { Icon: Presentation, color: 'text-text-300' },
  python: { Icon: FileTerminal, color: 'text-text-300' },
  r: { Icon: Sigma, color: 'text-text-300' },
  sequence: { Icon: Dna, color: 'text-text-300' },
  spreadsheet: { Icon: FileSpreadsheet, color: 'text-text-300' },
  text: { Icon: FileText, color: 'text-text-300' },
  unknown: { Icon: File, color: 'text-text-300' },
  vector: { Icon: VectorSquare, color: 'text-text-300' }
}

type FileTypeIconProps = {
  name: string
  mimeType?: string
  className?: string
}

const FILE_ICON_BASE_CLASS_NAME =
  'inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-border-200/60 bg-bg-200 p-0.5'

export const FileTypeIcon = ({
  name,
  mimeType,
  className
}: FileTypeIconProps): React.JSX.Element => {
  const { Icon, color } = FILE_ICON_PRESENTATION[getFileIconKind(name, mimeType)]

  return (
    <span className={cn(FILE_ICON_BASE_CLASS_NAME, color, className)} aria-hidden="true">
      <Icon className="size-full" strokeWidth={2.4} />
    </span>
  )
}
