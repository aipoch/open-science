import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'

type Heading = { text: string; level: number }

export const mountDocxOutlineSelect = (
  host: HTMLElement,
  label: string,
  headings: Heading[],
  onSelect: (index: number) => void
): { setActiveIndex: (index: number | undefined) => void; dispose: () => void } => {
  const root = createRoot(host)
  let activeIndex = ''
  const render = (): void => {
    root.render(
      <Select
        value={activeIndex}
        onValueChange={(value) => {
          activeIndex = value
          render()
          onSelect(Number(value))
        }}
      >
        <SelectTrigger aria-label={label} className="h-8 min-w-0">
          <SelectValue placeholder={label} />
        </SelectTrigger>
        <SelectContent className="max-w-72">
          {headings.map(({ text, level }, index) => (
            <SelectItem
              key={index}
              value={String(index)}
              textValue={text}
              style={{ paddingLeft: `${0.5 + level * 0.75}rem` }}
            >
              {text.slice(0, 100)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }

  flushSync(render)
  return {
    setActiveIndex(index) {
      const value = index === undefined ? '' : String(index)
      if (value === activeIndex) return
      activeIndex = value
      render()
    },
    dispose: () => root.unmount()
  }
}
