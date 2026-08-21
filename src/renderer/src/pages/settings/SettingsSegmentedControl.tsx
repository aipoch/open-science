import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
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

const AdaptiveSegmentLabel = ({ children }: { children: string | number }): React.JSX.Element => {
  const labelRef = useRef<HTMLSpanElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)
  const [compactFontSize, setCompactFontSize] = useState<number>()
  const measure = useCallback(() => {
    const label = labelRef.current
    const text = textRef.current
    if (!label || !text) return

    const previousStyle = {
      fontSize: text.style.fontSize,
      lineHeight: text.style.lineHeight,
      maxHeight: text.style.maxHeight,
      overflowWrap: text.style.overflowWrap,
      whiteSpace: text.style.whiteSpace
    }
    text.style.fontSize = '0.75rem'
    text.style.lineHeight = '1rem'
    text.style.maxHeight = 'none'
    text.style.whiteSpace = 'nowrap'
    const normalWidth = text.scrollWidth

    let nextCompactFontSize: number | undefined
    if (normalWidth > label.clientWidth + 1) {
      text.style.maxHeight = 'none'
      text.style.overflowWrap = 'break-word'
      text.style.whiteSpace = 'normal'
      for (const candidate of [10, 9, 8]) {
        text.style.fontSize = `${candidate}px`
        text.style.lineHeight = `${candidate + 2}px`
        nextCompactFontSize = candidate
        if (text.scrollHeight <= 25) break
      }
    }
    Object.assign(text.style, previousStyle)

    setCompactFontSize((current) =>
      current === nextCompactFontSize ? current : nextCompactFontSize
    )
  }, [])

  useLayoutEffect(() => {
    measure()
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(measure)
    observer.observe(labelRef.current!)
    observer.observe(textRef.current!)
    return () => observer.disconnect()
  }, [children, measure])

  return (
    <span
      ref={labelRef}
      data-slot="settings-segment-label"
      data-compact={compactFontSize === undefined ? undefined : true}
      data-compact-size={compactFontSize}
      className="relative flex h-full w-full min-w-0 items-center justify-center overflow-hidden"
    >
      <span
        ref={textRef}
        data-slot="settings-segment-label-text"
        className={cn(
          'block max-w-full text-center',
          compactFontSize === undefined
            ? 'whitespace-nowrap text-xs leading-4'
            : 'max-h-6 whitespace-normal break-words'
        )}
        style={
          compactFontSize === undefined
            ? undefined
            : { fontSize: `${compactFontSize}px`, lineHeight: `${compactFontSize + 2}px` }
        }
      >
        {children}
      </span>
    </span>
  )
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
      'relative z-10 flex h-7 items-center justify-center rounded-md px-1 text-xs font-medium transition-colors motion-reduce:transition-none',
      selected ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
      segmentClassName
    )
  const segmentLabel = (label: ReactNode): ReactNode =>
    typeof label === 'string' || typeof label === 'number' ? (
      <AdaptiveSegmentLabel>{label}</AdaptiveSegmentLabel>
    ) : (
      label
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
              {segmentLabel(option.label)}
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
          {segmentLabel(option.label)}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  )
}

export { SettingsSegmentedControl }
export type { SettingsSegmentedControlOption }
