import '@/assets/main.css'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SkillUsageAgents } from '@/pages/settings/SkillUsageAgents'
import {
  SessionHoverPreview,
  SessionHoverPreviewProvider
} from '@/pages/workspace/SessionHoverPreview'

const params = new URLSearchParams(location.search)
document.documentElement.classList.toggle('dark', params.has('dark'))
const longCopy =
  '这是包含很长文件名称的提示。 Dies ist ein langer Hinweis mit zusätzlichen Informationen. '.repeat(
    5
  )

export function Fixture(): React.JSX.Element {
  const [opened, setOpened] = useState('')
  return (
    <main className="min-h-screen bg-background p-8 text-foreground">
      <button>Outside</button>
      <TooltipProvider>
        <section className="m-40 flex gap-8" aria-label="Tooltips">
          {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
            <Tooltip key={side}>
              <TooltipTrigger>{side}</TooltipTrigger>
              <TooltipContent side={side} data-testid={`bubble-${side}`}>
                {side} details
              </TooltipContent>
            </Tooltip>
          ))}
        </section>
        <div className="fixed right-2 top-2">
          <Tooltip>
            <TooltipTrigger>Edge</TooltipTrigger>
            <TooltipContent side="right" collisionPadding={8} data-testid="edge-bubble">
              {longCopy}
            </TooltipContent>
          </Tooltip>
        </div>
      </TooltipProvider>
      <section className="flex gap-16" aria-label="Information previews">
        <SkillUsageAgents
          mainEnabled
          usages={[{ id: 'analyst', name: 'Analyst', kind: 'custom' }]}
          onOpenSpecialist={(usage) => setOpened(usage.name)}
        />
        <div className="flex w-28 flex-col gap-12">
          <SessionHoverPreviewProvider>
            {['First', 'Second'].map((name) => (
              <SessionHoverPreview
                key={name}
                session={{ id: name, title: `${name} session`, description: 'Preview description' }}
                canRename
                onRenameTitle={() => true}
              >
                <button>{name} row</button>
              </SessionHoverPreview>
            ))}
          </SessionHoverPreviewProvider>
        </div>
        <Popover>
          <PopoverTrigger>Click panel</PopoverTrigger>
          <PopoverContent data-testid="click-panel">Click-only content</PopoverContent>
        </Popover>
      </section>
      <output aria-label="Opened specialist">{opened}</output>
    </main>
  )
}

initI18n('en')
createRoot(document.getElementById('root')!).render(<Fixture />)
