import { CircleHelp } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

type FieldHelpProps = {
  content: ReactNode
}

// Keeps field guidance compact and consistent while callers retain ownership of the help content.
const FieldHelp = ({ content }: FieldHelpProps): React.JSX.Element => (
  <TooltipProvider delayDuration={200}>
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="More information"
          data-slot="field-help"
          className="size-[18px] rounded-full bg-transparent text-muted-foreground/50 hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground data-[state=delayed-open]:bg-muted data-[state=delayed-open]:text-foreground data-[state=instant-open]:bg-muted data-[state=instant-open]:text-foreground"
        >
          <CircleHelp className="size-3" aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={6}
        className="max-w-[280px] px-3 py-2 text-xs leading-5 whitespace-normal"
      >
        {content}
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
)

export { FieldHelp }
