// Ordered registry of the 7 settings UX changes demonstrated by the visual preview. Copy is
// Chinese because this is a design-review tool for a Chinese-speaking reviewer; it is debug
// tooling, not product UI, so it deliberately bypasses the i18n catalogs (no t() call sites).

import type { SettingsPanelId } from '../settings-navigation'
import { getSettingsPreviewState, setSettingsPreviewCompute } from './preview-store'

export type SettingsVisualChangeContext = {
  navigatePanel: (panel: SettingsPanelId) => void
}

export type SettingsVisualChange = {
  id: string
  title: string
  description: string
  panel: SettingsPanelId
  // CSS selector of the region carrying the change's data-visual-change attribute.
  targetSelector: string
  // Navigates to the panel, prepares the scenario, waits for the target (lazy panel chunks load
  // asynchronously, so this polls like highlightNavigatedPanel in SettingsGlobalSearch) and
  // scrolls it into view. Resolves false when the target could not be reached.
  activate: (context: SettingsVisualChangeContext) => Promise<boolean>
}

const POLL_INTERVAL_MS = 150
const POLL_TIMEOUT_MS = 5000

const waitFor = (
  resolve: () => HTMLElement | null,
  timeoutMs = POLL_TIMEOUT_MS
): Promise<HTMLElement | null> =>
  new Promise((done) => {
    const startedAt = Date.now()
    const attempt = (): void => {
      const found = resolve()
      if (found) {
        done(found)
        return
      }
      if (Date.now() - startedAt >= timeoutMs) {
        done(null)
        return
      }
      window.setTimeout(attempt, POLL_INTERVAL_MS)
    }
    attempt()
  })

const waitForSelector = (selector: string): Promise<HTMLElement | null> =>
  waitFor(() => {
    const element = document.querySelector<HTMLElement>(selector)
    return element && element.isConnected ? element : null
  })

const clickElement = (element: HTMLElement): void => {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

export const SETTINGS_VISUAL_CHANGES: ReadonlyArray<SettingsVisualChange> = [
  {
    id: 'compute-load-states',
    title: '计算面板加载与错误状态',
    description:
      '加载中与加载失败统一改用共享的 SettingsLoadNotice：加载态带 role="status" 与旋转指示，失败态带「重试」按钮，点击重试可恢复出主机列表。',
    panel: 'compute',
    targetSelector: '[data-visual-change="compute-load-states"]',
    activate: async ({ navigatePanel }) => {
      // Arm the failure scenario first so the panel renders the error state on entry.
      setSettingsPreviewCompute({ status: 'error' })
      navigatePanel('compute')
      const target = await waitForSelector(
        '[data-visual-change="compute-load-states"] [role="alert"]'
      )
      target?.scrollIntoView({ block: 'center' })
      return target !== null
    }
  },
  {
    id: 'compute-removal-inline-confirm',
    title: '主机移除对话框内联二次确认',
    description:
      '「清理远程文件 / 放弃清理 / 全部清理」不再弹出 window.confirm，而是在同一 AlertDialog 内把按钮变为 确认/取消 的内联确认区。示例主机带一个运行中的作业，可看到阻止列表。',
    panel: 'compute',
    targetSelector: '[data-visual-change="compute-removal-inline-confirm"]',
    activate: async ({ navigatePanel }) => {
      // Recover the list first (change 1 may have left the failure state on), then click through
      // the real UI: host row remove button → dialog → 查看阻止列表.
      setSettingsPreviewCompute({ status: 'ready' })
      navigatePanel('compute')
      const trigger = await waitForSelector('[data-slot="compute-host-removal-trigger"]')
      if (!trigger) return false
      clickElement(trigger)
      const dialog = await waitForSelector('[role="alertdialog"]')
      if (!dialog) return false
      const jobsToggle = await waitFor(() => {
        const button = dialog.querySelector<HTMLElement>(
          '[data-slot="compute-blocking-jobs-toggle"]'
        )
        return button && !button.hasAttribute('disabled') ? button : null
      })
      if (!jobsToggle) return false
      clickElement(jobsToggle)
      dialog.scrollIntoView({ block: 'center' })
      return true
    }
  },
  {
    id: 'remote-revoke-confirmation',
    title: '撤销受信任浏览器前增加确认',
    description:
      '受信任浏览器有效期 180 天，垃圾桶按钮原先一点即删。现在先弹出 AlertDialog 说明后果，确认后才真正撤销。点击条目旁的垃圾桶按钮查看确认框。',
    panel: 'remote-control',
    targetSelector: '[data-visual-change="remote-revoke-confirmation"]',
    activate: async ({ navigatePanel }) => {
      navigatePanel('remote-control')
      const target = await waitForSelector(
        'section[data-visual-change="remote-revoke-confirmation"]'
      )
      target?.scrollIntoView({ block: 'center' })
      return target !== null
    }
  },
  {
    id: 'remote-pairing-first',
    title: '配对请求前置并强化时效提示',
    description:
      '配对请求是会过期的待办，现在排在受信任浏览器之前。标题带数量徽标与「需要处理」状态；每张请求卡新增验证码过期倒计时（≤2 分钟变琥珀色警示）与安全提示条。示例含两条待配对请求，其中一条即将过期。',
    panel: 'remote-control',
    targetSelector: '[data-visual-change="remote-pairing-first"]',
    activate: async ({ navigatePanel }) => {
      navigatePanel('remote-control')
      const target = await waitForSelector('section[data-visual-change="remote-pairing-first"]')
      target?.scrollIntoView({ block: 'center' })
      return target !== null
    }
  },
  {
    id: 'remote-revoke-all',
    title: '受信任浏览器支持批量撤销',
    description:
      '受信任浏览器超过一条时，区块标题右侧出现「全部撤销」，经 AlertDialog 确认后逐个撤销并清空列表。点击进入批量撤销确认框。',
    panel: 'remote-control',
    targetSelector: '[data-visual-change="remote-revoke-all"]',
    activate: async ({ navigatePanel }) => {
      navigatePanel('remote-control')
      const trigger = await waitForSelector('[data-slot="remote-revoke-all-trigger"]')
      if (!trigger) return false
      clickElement(trigger)
      const dialog = await waitForSelector('[data-visual-change="remote-revoke-all"]')
      dialog?.scrollIntoView({ block: 'center' })
      return dialog !== null
    }
  },
  {
    id: 'disabled-action-explanations',
    title: '禁用操作补充原因说明',
    description:
      '禁用按钮收不到指针事件，原生 title 提示永远不会出现。改为 span 包裹 + Radix Tooltip：归档面板「还原/删除」与连接器面板的启用开关，悬停或聚焦即可看到原因。',
    panel: 'archived',
    targetSelector: '[data-visual-change="disabled-action-explanations"]',
    activate: async ({ navigatePanel }) => {
      navigatePanel('archived')
      // Drill into the archived project through the real UI: its sessions show the disabled
      // Restore button with the "先还原项目" explanation.
      const projectRow = await waitFor(() => {
        const buttons = Array.from(
          document.querySelectorAll<HTMLElement>(
            '[data-settings-active-panel="archived"] button[type="button"]'
          )
        )
        return (
          buttons.find((button) =>
            getSettingsPreviewState().archived.projects.some(
              (project) =>
                project.archivedAt !== undefined && button.textContent?.includes(project.name)
            )
          ) ?? null
        )
      })
      if (!projectRow) return false
      clickElement(projectRow)
      const target = await waitForSelector('[data-visual-change="disabled-action-explanations"]')
      target?.scrollIntoView({ block: 'center' })
      return target !== null
    }
  },
  {
    id: 'credential-remove-disabled',
    title: '使用中凭据的移除按钮可见禁用',
    description:
      '被连接器占用的凭据，移除按钮原先靠静默 return 假装禁用：无置灰、无说明。现在置灰并显示 cursor-not-allowed，悬停/聚焦通过 Tooltip 解释需先解除占用；仍可键盘聚焦（aria-disabled）。',
    panel: 'credentials',
    targetSelector: '[data-visual-change="credential-remove-disabled"]',
    activate: async ({ navigatePanel }) => {
      navigatePanel('credentials')
      const target = await waitForSelector('[data-visual-change="credential-remove-disabled"]')
      target?.scrollIntoView({ block: 'center' })
      return target !== null
    }
  }
]
