import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { UpdateDialog } from '@/components/UpdateDialog'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { useUpdateStore } from '@/stores/update-store'

const params = new URLSearchParams(location.search)
const locale = params.get('locale') === 'zh-Hans' ? 'zh-Hans' : 'en'
const notes = Array.from(
  { length: params.has('short') ? 1 : 35 },
  (_, index) =>
    `- Release note ${index + 1}: Improved research workflows and application stability.`
).join('\n')
const localizedNotes = {
  'zh-Hans': Array.from(
    { length: params.has('short') ? 1 : 35 },
    (_, index) => `- 更新内容 ${index + 1}：改进科研工作流程，提升应用的稳定性与使用体验。`
  ).join('\n')
}
useUpdateStore.setState({
  isDialogOpen: true,
  status: {
    state: 'downloading',
    current: '0.28.0',
    latest: '0.29.0',
    notes,
    localizedNotes,
    progress: 99,
    downloadProgress: {
      phase: 'downloading',
      transferred: 47.2 * 1024 * 1024,
      total: 47.9 * 1024 * 1024,
      percent: 99,
      bytesPerSecond: 6.5 * 1024 * 1024,
      attempt: 0
    }
  }
})
void Promise.resolve(prepareI18nLocale(locale)).then(() => {
  initI18n(locale)
  createRoot(document.getElementById('root')!).render(<UpdateDialog />)
})
