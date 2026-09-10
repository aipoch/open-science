import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import { TextAnnotationSurface } from '@/pages/workspace/annotations/TextAnnotationSurface'

initI18n('en')

createRoot(document.getElementById('root')!).render(
  <main style={{ margin: 80, width: 500, fontSize: 16, lineHeight: '28px' }}>
    {[
      '第一段中文用于验证文本划选后批注按钮的稳定显示。',
      '第二段中文用于验证重新选择时旧批注按钮正确清理。'
    ].map((text, index) => (
      <TextAnnotationSurface
        key={index}
        source={{ kind: 'agent-message', sessionId: 'selection-test', messageId: String(index) }}
        activeAnnotations={[]}
        onAdd={() => undefined}
        onError={() => undefined}
      >
        <p data-testid={`paragraph-${index}`} style={{ marginBottom: 60 }}>
          {text}
        </p>
      </TextAnnotationSurface>
    ))}
  </main>
)
