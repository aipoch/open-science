import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'

const vertical = new URLSearchParams(location.search).has('vertical')
createRoot(document.getElementById('root')!).render(
  <main style={{ padding: 40 }}>
    <button style={{ cursor: 'pointer' }}>Unrelated action</button>
    <ResizablePanelGroup
      orientation={vertical ? 'vertical' : 'horizontal'}
      resizeTargetMinimumSize={{ fine: 20, coarse: 20 }}
      style={{ width: 800, height: 500 }}
    >
      <ResizablePanel id="first" defaultSize="50%" minSize="20%" maxSize="80%">
        <div style={{ height: '100%', cursor: 'text' }}>Synthetic text</div>
      </ResizablePanel>
      <ResizableHandle aria-label="Resize fixture" />
      <ResizablePanel id="second" minSize="20%">
        <iframe
          title="Synthetic iframe"
          srcDoc='<html><body style="margin:0;cursor:crosshair"><div style="height:100vh">Synthetic content</div></body></html>'
          style={{ width: '100%', height: '100%', border: 0 }}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  </main>
)
