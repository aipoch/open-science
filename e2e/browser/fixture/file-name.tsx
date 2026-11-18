import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { ExtensionPreservingFileName } from '@/pages/workspace/ExtensionPreservingFileName'

const query = new URLSearchParams(location.search)
const width = Number(query.get('width') ?? 96)
const name = query.get('name') ?? '示例文档_测试记录_阶段汇总_最终版本.md'
createRoot(document.getElementById('root')!).render(
  <main style={{ padding: 24, fontSize: 12 }}>
    {[false, true].map((compact) => (
      <div key={String(compact)} data-layout={compact ? 'compact' : 'normal'} style={{ width }}>
        <ExtensionPreservingFileName name={name} compact={compact} />
      </div>
    ))}
  </main>
)
