/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
/* Hallmark · component: import menu button · genre: modern-minimal · theme: Open Science Settings
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: pass (semantic Settings tokens)
 */
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Download,
  FileUp,
  FolderInput,
  LoaderCircle
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

type SkillImportMenuActions = {
  onUploadSkills: () => void
  onImportFromGitHub: () => void
  onImportInstalledSkills?: () => void
}

export type SkillImportMenuPreviewState =
  'default' | 'hover' | 'focus' | 'active' | 'disabled' | 'loading' | 'error' | 'success'

type SkillImportMenuProps = SkillImportMenuActions & {
  previewState?: SkillImportMenuPreviewState
}

const SkillImportMenuItems = ({
  onUploadSkills,
  onImportFromGitHub,
  onImportInstalledSkills
}: SkillImportMenuActions): React.JSX.Element => {
  const { t } = useTranslation()

  return (
    <>
      <DropdownMenuItem className="gap-2.5" onSelect={onUploadSkills}>
        <FileUp className="size-4 shrink-0" aria-hidden="true" />
        <span className="flex flex-col">
          <span>{t('Upload skills')}</span>
          <span className="text-xs text-muted-foreground">{t('Pick SKILL.md files')}</span>
        </span>
      </DropdownMenuItem>
      <DropdownMenuItem className="gap-2.5" onSelect={onImportFromGitHub}>
        <Download className="size-4 shrink-0" aria-hidden="true" />
        <span className="flex flex-col">
          <span>{t('Import from GitHub')}</span>
          <span className="text-xs text-muted-foreground">{t('Add a skill from a repo')}</span>
        </span>
      </DropdownMenuItem>
      {onImportInstalledSkills ? (
        <DropdownMenuItem className="gap-2.5" onSelect={onImportInstalledSkills}>
          <FolderInput className="size-4 shrink-0" aria-hidden="true" />
          <span className="flex flex-col">
            <span>{t('Import installed skills')}</span>
            <span className="text-xs text-muted-foreground">{t('Scan global skill folders')}</span>
          </span>
        </DropdownMenuItem>
      ) : null}
    </>
  )
}

const SkillImportMenu = ({
  onUploadSkills,
  onImportFromGitHub,
  onImportInstalledSkills,
  previewState = 'default'
}: SkillImportMenuProps): React.JSX.Element => {
  const { t } = useTranslation()
  const unavailable = previewState === 'disabled' || previewState === 'loading'
  const StateIcon =
    previewState === 'loading'
      ? LoaderCircle
      : previewState === 'error'
        ? AlertTriangle
        : previewState === 'success'
          ? Check
          : Download

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={unavailable}
          aria-busy={previewState === 'loading' || undefined}
          aria-invalid={previewState === 'error' || undefined}
          data-preview-state={previewState}
          className="shrink-0 transition-[color,background-color,border-color,transform] ease-out data-[preview-state=active]:translate-y-px data-[preview-state=error]:border-destructive data-[preview-state=error]:text-destructive data-[preview-state=focus]:border-ring data-[preview-state=focus]:ring-3 data-[preview-state=focus]:ring-ring/50 data-[preview-state=hover]:bg-muted data-[preview-state=success]:border-status-success-accent data-[preview-state=success]:text-status-success-foreground [@media(pointer:coarse)]:min-h-11"
        >
          <StateIcon
            data-icon="inline-start"
            className={
              previewState === 'loading' ? 'animate-spin motion-reduce:animate-none' : undefined
            }
            aria-hidden="true"
          />
          {t('Import')}
          <ChevronDown data-icon="inline-end" className="opacity-70" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <SkillImportMenuItems
          onUploadSkills={onUploadSkills}
          onImportFromGitHub={onImportFromGitHub}
          onImportInstalledSkills={onImportInstalledSkills}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export { SkillImportMenu, SkillImportMenuItems }
