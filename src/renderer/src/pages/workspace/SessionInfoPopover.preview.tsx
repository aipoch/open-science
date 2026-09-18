/* Development-only interactive preview. All Session data and saves below are illustrative. */
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { ChatSession } from '@/stores/session-store'
import { EditSessionDialog } from './EditSessionDialog'
import { SessionInfoPopover } from './SessionInfoPopover'

const SAMPLE: ChatSession = {
  id: 'preview-session',
  projectId: 'preview-project',
  number: 42,
  title: '对比不同培养条件下的细胞生长曲线，整理实验结果并生成可复现的分析报告',
  description:
    '整合三组实验数据，检查异常值与重复测量的一致性，比较不同培养条件下的细胞生长趋势，并整理图表、分析方法和后续实验建议。',
  cwd: '/preview',
  status: 'idle',
  createdAt: new Date('2026-09-16T09:30:00').getTime(),
  updatedAt: new Date('2026-09-18T10:42:00').getTime(),
  branchSource: { sessionId: 'source' },
  messages: Array.from({ length: 18 }, (_, index) => ({
    id: `message-${index}`,
    role: index % 3 === 0 ? 'user' : 'agent',
    content: '',
    status: 'complete',
    eventIds: [],
    createdAt: index,
    updatedAt: index
  })),
  artifacts: Array.from({ length: 5 }, (_, index) => ({
    id: `artifact-${index}`,
    kind: 'workspace-file',
    path: `figure-${index}.png`
  }))
}
const STATES = [
  'default',
  'hover',
  'focus',
  'active',
  'disabled',
  'loading',
  'error',
  'success'
] as const

const SessionInfoPopoverPreview = (): React.JSX.Element => {
  const { i18n } = useTranslation()
  const [session, setSession] = useState(SAMPLE)
  const [editing, setEditing] = useState<ChatSession>()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [state, setState] = useState<(typeof STATES)[number]>('default')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  return (
    <main className="min-h-svh bg-background p-4 text-foreground sm:p-8">
      <p className="text-xs text-muted-foreground">
        Session information · interactive preview · sample data
      </p>
      <div className="my-5 flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => document.documentElement.classList.toggle('dark')}>
          Light / dark
        </Button>
        <Button
          variant="outline"
          onClick={() => void i18n.changeLanguage(i18n.language === 'zh-Hans' ? 'en' : 'zh-Hans')}
        >
          中文 / English
        </Button>
      </div>
      <div className="max-w-xl">
        <SessionInfoPopover
          key={session.id}
          onTogglePin={
            state === 'disabled'
              ? undefined
              : () => setSession((current) => ({ ...current, pinned: !current.pinned }))
          }
          session={{ ...session, ...(state === 'loading' ? { contentLoaded: false } : {}) }}
          sourceSession={{ id: 'source', title: '细胞培养实验 · 初步数据整理', number: 28 }}
          onOpenSession={() =>
            setSession({
              ...SAMPLE,
              id: 'source',
              number: 28,
              title: '细胞培养实验 · 初步数据整理',
              branchSource: undefined
            })
          }
          onEdit={
            state === 'disabled'
              ? undefined
              : (selected) => {
                  returnFocus.current = document.activeElement as HTMLElement
                  setTitle(selected.title)
                  setDescription(selected.description ?? '')
                  setError(null)
                  setEditing(selected)
                }
          }
        />
      </div>
      <p className="mt-6 max-w-md text-sm leading-6 text-muted-foreground">
        点击上方标题查看信息，或打开编辑弹窗。此预览中的修改仅保存在当前页面。
      </p>
      <div className="mt-10 grid max-w-sm gap-2">
        {STATES.map((item) => (
          <div
            key={item}
            className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-3 text-xs"
          >
            <span className="text-muted-foreground">{item}</span>
            <Button
              variant="outline"
              className={
                item === 'hover'
                  ? 'bg-muted'
                  : item === 'focus'
                    ? 'outline-2 outline-offset-2 outline-ring'
                    : item === 'active'
                      ? 'translate-y-px bg-muted'
                      : ''
              }
              onClick={() => {
                setState(item)
                setSession(SAMPLE)
              }}
            >
              {item === 'error'
                ? 'Simulate failed save'
                : item === 'success'
                  ? 'Edit and save'
                  : `Preview ${item}`}
            </Button>
          </div>
        ))}
      </div>
      <EditSessionDialog
        session={editing}
        titleDraft={title}
        descriptionDraft={description}
        isSaving={saving}
        error={error}
        onTitleDraftChange={setTitle}
        onDescriptionDraftChange={setDescription}
        onCancel={() => {
          if (!saving) setEditing(undefined)
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          returnFocus.current?.focus()
        }}
        onConfirmEdit={(event) => {
          event.preventDefault()
          setSaving(true)
          window.setTimeout(() => {
            setSaving(false)
            if (state === 'error') setError(i18n.t('Could not save session details.'))
            else {
              setSession({ ...session, title, description, updatedAt: Date.now() })
              setEditing(undefined)
            }
          }, 700)
        }}
      />
    </main>
  )
}
export { SessionInfoPopoverPreview }
