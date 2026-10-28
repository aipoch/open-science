import '@/assets/main.css'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChevronDown } from 'lucide-react'
import { initI18n } from '@/i18n'
import {
  SplitButton,
  SplitButtonGroup,
  SplitButtonPrimary,
  SplitButtonTrigger,
  SplitButtonContent
} from '@/components/ui/split-button'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { PermissionScopeButton } from '@/pages/workspace/PermissionScopeButton'

const params = new URLSearchParams(location.search)
document.documentElement.classList.toggle('dark', params.has('dark'))
export const Fixture = (): React.JSX.Element => {
  const [result, setResult] = useState('')
  return (
    <main style={{ padding: 20 }}>
      <button onClick={() => setResult('outside')}>Outside</button>
      <output data-testid="result">{result}</output>
      <div
        style={{
          position: 'fixed',
          ...(params.has('bottom') ? { bottom: 12 } : { top: 70 }),
          ...(params.has('shift') ? { left: 8 } : { right: 20 })
        }}
      >
        {params.has('scope') ? (
          <PermissionScopeButton
            available={['once', 'session', 'project', 'global']}
            disabled={false}
            onAllow={setResult}
          />
        ) : (
          <SplitButton
            kind={params.has('popover') ? 'popover' : 'menu'}
            disabled={params.has('disabled')}
            busy={params.has('busy')}
            hideMenu={params.has('single')}
          >
            <SplitButtonGroup>
              <SplitButtonPrimary
                disabled={params.has('main-off')}
                onClick={() => setResult('send')}
              >
                Send
              </SplitButtonPrimary>
              <SplitButtonTrigger disabled={params.has('menu-off')} aria-label="Options">
                <ChevronDown />
              </SplitButtonTrigger>
            </SplitButtonGroup>
            <SplitButtonContent
              onOpenAutoFocus={
                params.has('prevent-focus') ? (event) => event.preventDefault() : undefined
              }
              side={params.has('bottom') ? 'bottom' : 'top'}
              align="end"
              matchWidth={!params.has('wide')}
              style={params.has('wide') ? { width: 280 } : undefined}
            >
              {['Plan', 'Branch', 'Review', 'Archive', 'Cancel'].map((label) =>
                params.has('popover') ? (
                  <button key={label} onClick={() => setResult(label)}>
                    {label}
                  </button>
                ) : (
                  <DropdownMenuItem key={label} onSelect={() => setResult(label)}>
                    {label}
                  </DropdownMenuItem>
                )
              )}
            </SplitButtonContent>
          </SplitButton>
        )}
      </div>
      <button>After</button>
    </main>
  )
}
initI18n('en')
createRoot(document.getElementById('root')!).render(<Fixture />)
