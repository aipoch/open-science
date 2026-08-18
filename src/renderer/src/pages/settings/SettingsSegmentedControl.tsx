import { useState, type ReactNode } from 'react'
import { RadioGroup, Tabs } from 'radix-ui'

import { cn } from '@/lib/utils'

type SettingsSegmentedControlOption<Value extends string> = {
  value: Value
  label: ReactNode
}

type SettingsSegmentedControlProps<Value extends string> = {
  value: Value
  options: readonly SettingsSegmentedControlOption<Value>[]
  onValueChange: (value: Value) => void
  ariaLabel: string
  semantics?: 'radio' | 'tab'
  columnWidth?: string
  className?: string
  segmentClassName?: string
}

const SettingsSegmentedControl = <Value extends string>({
  value,
  options,
  onValueChange,
  ariaLabel,
  semantics = 'radio',
  columnWidth = '4rem',
  className,
  segmentClassName
}: SettingsSegmentedControlProps<Value>): React.JSX.Element => {
  const [interactive, setInteractive] = useState(false)
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value)
  )
  const gridStyle = { gridTemplateColumns: `repeat(${options.length}, ${columnWidth})` }
  const selectValue = (nextValue: string): void => {
    setInteractive(true)
    onValueChange(nextValue as Value)
  }
  const indicator = (
    <span
      aria-hidden="true"
      className={cn(
        'absolute inset-y-0.5 left-0.5 rounded-md bg-card shadow-sm',
        interactive && 'transition-transform duration-150 motion-reduce:transition-none'
      )}
      style={{
        width: columnWidth,
        transform: `translateX(${selectedIndex * 100}%)`
      }}
    />
  )
  const segmentClasses = (selected: boolean): string =>
    cn(
      'relative z-10 flex h-7 items-center justify-center rounded-md px-2 text-xs font-medium transition-colors motion-reduce:transition-none',
      selected ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
      segmentClassName
    )

  if (semantics === 'tab') {
    return (
      <Tabs.Root
        value={value}
        onValueChange={selectValue}
        orientation="horizontal"
        className="w-fit"
      >
        <Tabs.List
          aria-label={ariaLabel}
          className={cn('relative grid w-fit rounded-lg bg-muted p-0.5', className)}
          style={gridStyle}
        >
          {indicator}
          {options.map((option, index) => (
            <Tabs.Trigger
              key={option.value}
              value={option.value}
              className={segmentClasses(index === selectedIndex)}
            >
              {option.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
      </Tabs.Root>
    )
  }

  return (
    <RadioGroup.Root
      aria-label={ariaLabel}
      value={value}
      onValueChange={selectValue}
      orientation="horizontal"
      className={cn('relative grid w-fit rounded-lg bg-muted p-0.5', className)}
      style={gridStyle}
    >
      {indicator}
      {options.map((option, index) => (
        <RadioGroup.Item
          key={option.value}
          value={option.value}
          className={segmentClasses(index === selectedIndex)}
        >
          {option.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  )
}

export { SettingsSegmentedControl }
export type { SettingsSegmentedControlOption }
