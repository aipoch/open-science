import type { Locale } from '../../shared/locale'

const englishMessages = {
  'Open Web UI': 'Open Web UI',
  'Copy URL': 'Copy URL',
  Quit: 'Quit',
  Show: 'Show',
  Hide: 'Hide',
  'Return to tasks': 'Return to tasks',
  'Minimize to tray': 'Minimize to tray',
  'Subagents are still running': 'Subagents are still running',
  'Return to the running tasks and stop their subagents before quitting Open Science.':
    'Return to the running tasks and stop their subagents before quitting Open Science.',
  Cancel: 'Cancel',
  'Quit Open Science?': 'Quit Open Science?',
  'Work is still running and will be interrupted if you quit.':
    'Work is still running and will be interrupted if you quit.',
  'Minimize to tray or quit?': 'Minimize to tray or quit?',
  'Background work may still be running.': 'Background work may still be running.',
  "Don't ask again": "Don't ask again",
  'Keep waiting': 'Keep waiting',
  'Quit anyway': 'Quit anyway',
  'Move in progress': 'Move in progress',
  'Open Science is still moving your data.': 'Open Science is still moving your data.',
  'Your data is safe either way, but quitting now leaves the move unfinished — you may need to start it again. Keep the app open until it finishes.':
    'Your data is safe either way, but quitting now leaves the move unfinished — you may need to start it again. Keep the app open until it finishes.',
  Reload: 'Reload',
  'Close window': 'Close window',
  'The app window stopped responding repeatedly.': 'The app window stopped responding repeatedly.',
  'Automatic recovery has been paused. Reloading returns this window to the home screen; background work may still be running.':
    'Automatic recovery has been paused. Reloading returns this window to the home screen; background work may still be running.',
  'Save file': 'Save file',
  'Save artifact': 'Save artifact',
  'Choose where to save artifacts': 'Choose where to save artifacts',
  'Download project artifacts': 'Download project artifacts',
  'Export conversation': 'Export conversation',
  Markdown: 'Markdown',
  PDF: 'PDF',
  'Export notebook': 'Export notebook',
  'Jupyter Notebook': 'Jupyter Notebook',
  'Export notebooks by kernel': 'Export notebooks by kernel',
  'Overwrite existing notebooks?': 'Overwrite existing notebooks?',
  '{{count}} notebook already exists in the chosen directory.':
    '{{count}} notebook already exists in the chosen directory.',
  '{{count}} notebooks already exist in the chosen directory.':
    '{{count}} notebooks already exist in the chosen directory.',
  Overwrite: 'Overwrite',
  'Save the update installer': 'Save the update installer',
  'Export Skill': 'Export Skill',
  'Skill ZIP': 'Skill ZIP',
  'ZIP archive': 'ZIP archive',
  'Save contribution template': 'Save contribution template',
  'Specialist ZIP': 'Specialist ZIP',
  'JSON report': 'JSON report',
  'Import Connector configuration': 'Import Connector configuration',
  'Export Connector configuration': 'Export Connector configuration',
  'Connector configuration': 'Connector configuration'
} as const

export type NativeMessageKey = keyof typeof englishMessages
type NativeMessages = Record<NativeMessageKey, string>
export type NativeTranslator = (
  key: NativeMessageKey,
  values?: Record<string, string | number>
) => string

const zhHansMessages: NativeMessages = {
  'Open Web UI': '打开 Web 界面',
  'Copy URL': '复制 URL',
  Quit: '退出',
  Show: '显示',
  Hide: '隐藏',
  'Return to tasks': '返回任务',
  'Minimize to tray': '最小化到托盘',
  'Subagents are still running': 'Subagent 仍在运行',
  'Return to the running tasks and stop their subagents before quitting Open Science.':
    '请返回正在运行的任务并停止其 Subagent，然后再退出 Open Science。',
  Cancel: '取消',
  'Quit Open Science?': '退出 Open Science？',
  'Work is still running and will be interrupted if you quit.': '工作仍在运行，退出会将其中断。',
  'Minimize to tray or quit?': '最小化到托盘还是退出？',
  'Background work may still be running.': '后台工作可能仍在运行。',
  "Don't ask again": '不再询问',
  'Keep waiting': '继续等待',
  'Quit anyway': '仍然退出',
  'Move in progress': '正在迁移',
  'Open Science is still moving your data.': 'Open Science 仍在迁移你的数据。',
  'Your data is safe either way, but quitting now leaves the move unfinished — you may need to start it again. Keep the app open until it finishes.':
    '无论如何你的数据都是安全的，但现在退出会使迁移未完成，你可能需要重新开始。请保持应用打开，直到迁移完成。',
  Reload: '重新加载',
  'Close window': '关闭窗口',
  'The app window stopped responding repeatedly.': '应用窗口多次停止响应。',
  'Automatic recovery has been paused. Reloading returns this window to the home screen; background work may still be running.':
    '自动恢复已暂停。重新加载会使此窗口返回主页；后台工作可能仍在运行。',
  'Save file': '保存文件',
  'Save artifact': '保存产物',
  'Choose where to save artifacts': '选择产物保存位置',
  'Download project artifacts': '下载项目产物',
  'Export conversation': '导出对话',
  Markdown: 'Markdown',
  PDF: 'PDF',
  'Export notebook': '导出 Notebook',
  'Jupyter Notebook': 'Jupyter Notebook',
  'Export notebooks by kernel': '按内核导出 Notebook',
  'Overwrite existing notebooks?': '覆盖现有 Notebook？',
  '{{count}} notebook already exists in the chosen directory.':
    '所选目录中已存在 {{count}} 个 Notebook。',
  '{{count}} notebooks already exist in the chosen directory.':
    '所选目录中已存在 {{count}} 个 Notebook。',
  Overwrite: '覆盖',
  'Save the update installer': '保存更新安装程序',
  'Export Skill': '导出 Skill',
  'Skill ZIP': 'Skill ZIP',
  'ZIP archive': 'ZIP 压缩包',
  'Save contribution template': '保存贡献模板',
  'Specialist ZIP': 'Specialist ZIP',
  'JSON report': 'JSON 报告',
  'Import Connector configuration': '导入 Connector 配置',
  'Export Connector configuration': '导出 Connector 配置',
  'Connector configuration': 'Connector 配置'
}

const zhHantMessages: NativeMessages = {
  'Open Web UI': '開啟 Web 介面',
  'Copy URL': '複製 URL',
  Quit: '結束',
  Show: '顯示',
  Hide: '隱藏',
  'Return to tasks': '返回工作',
  'Minimize to tray': '最小化至系統匣',
  'Subagents are still running': 'Subagent 仍在執行',
  'Return to the running tasks and stop their subagents before quitting Open Science.':
    '請返回執行中的工作並停止其 Subagent，然後再結束 Open Science。',
  Cancel: '取消',
  'Quit Open Science?': '結束 Open Science？',
  'Work is still running and will be interrupted if you quit.': '工作仍在執行，結束會將其中斷。',
  'Minimize to tray or quit?': '最小化至系統匣還是結束？',
  'Background work may still be running.': '背景工作可能仍在執行。',
  "Don't ask again": '不再詢問',
  'Keep waiting': '繼續等待',
  'Quit anyway': '仍要結束',
  'Move in progress': '正在移動',
  'Open Science is still moving your data.': 'Open Science 仍在移動你的資料。',
  'Your data is safe either way, but quitting now leaves the move unfinished — you may need to start it again. Keep the app open until it finishes.':
    '無論如何你的資料都是安全的，但現在結束會使移動未完成，你可能需要重新開始。請保持應用程式開啟，直到移動完成。',
  Reload: '重新載入',
  'Close window': '關閉視窗',
  'The app window stopped responding repeatedly.': '應用程式視窗多次停止回應。',
  'Automatic recovery has been paused. Reloading returns this window to the home screen; background work may still be running.':
    '自動復原已暫停。重新載入會使此視窗返回首頁；背景工作可能仍在執行。',
  'Save file': '儲存檔案',
  'Save artifact': '儲存產物',
  'Choose where to save artifacts': '選擇產物儲存位置',
  'Download project artifacts': '下載專案產物',
  'Export conversation': '匯出對話',
  Markdown: 'Markdown',
  PDF: 'PDF',
  'Export notebook': '匯出 Notebook',
  'Jupyter Notebook': 'Jupyter Notebook',
  'Export notebooks by kernel': '依核心匯出 Notebook',
  'Overwrite existing notebooks?': '覆寫現有 Notebook？',
  '{{count}} notebook already exists in the chosen directory.':
    '所選目錄中已存在 {{count}} 個 Notebook。',
  '{{count}} notebooks already exist in the chosen directory.':
    '所選目錄中已存在 {{count}} 個 Notebook。',
  Overwrite: '覆寫',
  'Save the update installer': '儲存更新安裝程式',
  'Export Skill': '匯出 Skill',
  'Skill ZIP': 'Skill ZIP',
  'ZIP archive': 'ZIP 壓縮檔',
  'Save contribution template': '儲存貢獻範本',
  'Specialist ZIP': 'Specialist ZIP',
  'JSON report': 'JSON 報告',
  'Import Connector configuration': '匯入 Connector 設定',
  'Export Connector configuration': '匯出 Connector 設定',
  'Connector configuration': 'Connector 設定'
}

const jaMessages: NativeMessages = {
  'Open Web UI': 'Web UI を開く',
  'Copy URL': 'URL をコピー',
  Quit: '終了',
  Show: '表示',
  Hide: '非表示',
  'Return to tasks': 'タスクに戻る',
  'Minimize to tray': 'トレイに最小化',
  'Subagents are still running': 'Subagent がまだ実行中です',
  'Return to the running tasks and stop their subagents before quitting Open Science.':
    '実行中のタスクに戻って Subagent を停止してから、Open Science を終了してください。',
  Cancel: 'キャンセル',
  'Quit Open Science?': 'Open Science を終了しますか？',
  'Work is still running and will be interrupted if you quit.':
    '作業はまだ実行中です。終了すると中断されます。',
  'Minimize to tray or quit?': 'トレイに最小化しますか、それとも終了しますか？',
  'Background work may still be running.': 'バックグラウンドの作業がまだ実行中の可能性があります。',
  "Don't ask again": '今後確認しない',
  'Keep waiting': '待機を続ける',
  'Quit anyway': '終了する',
  'Move in progress': '移動中',
  'Open Science is still moving your data.': 'Open Science はまだデータを移動しています。',
  'Your data is safe either way, but quitting now leaves the move unfinished — you may need to start it again. Keep the app open until it finishes.':
    'どちらを選んでもデータは安全ですが、今終了すると移動が未完了になり、やり直しが必要になる場合があります。完了するまでアプリを開いたままにしてください。',
  Reload: '再読み込み',
  'Close window': 'ウィンドウを閉じる',
  'The app window stopped responding repeatedly.':
    'アプリのウィンドウが繰り返し応答しなくなりました。',
  'Automatic recovery has been paused. Reloading returns this window to the home screen; background work may still be running.':
    '自動復旧は一時停止されています。再読み込みするとこのウィンドウはホーム画面に戻ります。バックグラウンドの作業はまだ実行中の可能性があります。',
  'Save file': 'ファイルを保存',
  'Save artifact': 'アーティファクトを保存',
  'Choose where to save artifacts': 'アーティファクトの保存先を選択',
  'Download project artifacts': 'プロジェクトのアーティファクトをダウンロード',
  'Export conversation': '会話をエクスポート',
  Markdown: 'Markdown',
  PDF: 'PDF',
  'Export notebook': 'Notebook をエクスポート',
  'Jupyter Notebook': 'Jupyter Notebook',
  'Export notebooks by kernel': 'カーネル別に Notebook をエクスポート',
  'Overwrite existing notebooks?': '既存の Notebook を上書きしますか？',
  '{{count}} notebook already exists in the chosen directory.':
    '選択したディレクトリには {{count}} 個の Notebook がすでに存在します。',
  '{{count}} notebooks already exist in the chosen directory.':
    '選択したディレクトリには {{count}} 個の Notebook がすでに存在します。',
  Overwrite: '上書き',
  'Save the update installer': '更新インストーラーを保存',
  'Export Skill': 'Skill をエクスポート',
  'Skill ZIP': 'Skill ZIP',
  'ZIP archive': 'ZIP アーカイブ',
  'Save contribution template': 'コントリビューションテンプレートを保存',
  'Specialist ZIP': 'Specialist ZIP',
  'JSON report': 'JSON レポート',
  'Import Connector configuration': 'Connector 設定をインポート',
  'Export Connector configuration': 'Connector 設定をエクスポート',
  'Connector configuration': 'Connector 設定'
}

const messages: Record<Locale, NativeMessages> = {
  en: englishMessages,
  'zh-Hans': zhHansMessages,
  'zh-Hant': zhHantMessages,
  ja: jaMessages
}

export const translateNativeMessage = (
  locale: Locale,
  key: NativeMessageKey,
  values: Record<string, string | number> = {}
): string =>
  Object.entries(values).reduce(
    (message, [name, value]) => message.replaceAll(`{{${name}}}`, String(value)),
    messages[locale][key]
  )

export const englishNativeTranslator: NativeTranslator = (key, values) =>
  translateNativeMessage('en', key, values)

export { englishMessages }
