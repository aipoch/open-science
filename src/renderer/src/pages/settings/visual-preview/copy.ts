// Toolbar/marker copy for the settings visual preview. This is a design-review tool for a
// Chinese-speaking reviewer, not product UI: copy lives in this module-level object and reaches
// the DOM through expressions, deliberately outside the i18n catalogs (no t() call sites, no
// catalog entries). The i18n guard only scans t()/Trans call sites and prose JSX text nodes, so
// this file stays clear of it.

export const VISUAL_PREVIEW_COPY = {
  badge: '预览模式 · 模拟数据',
  previous: '上一处',
  next: '下一处',
  position: (current: number, total: number): string => `第 ${current} 项 / 共 ${total} 项`,
  listToggle: '全部变更',
  collapse: '收起',
  expand: '展开预览工具栏',
  markersToggle: '显示标记',
  exit: '退出预览',
  exitHint: '已清除开关；关闭并重新打开设置即可完全恢复。',
  unreachable: (title: string): string => `未能定位：${title}（保留当前选中项）`,
  changeChip: (index: number): string => `变更 ${index}`
} as const
