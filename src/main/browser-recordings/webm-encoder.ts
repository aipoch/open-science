import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { recordingDeadline } from './driver-deadline'

export type RecordingMask = Readonly<{ x: number; y: number; width: number; height: number }>
export type WebmSegment = Readonly<{
  bytes: Uint8Array
  startMs: number
  endMs: number
  width: number
  height: number
  codec: 'vp8'
  frameRate: number
}>
export type WebmEncoder = Readonly<{
  write(png: Uint8Array, masks: readonly RecordingMask[]): Promise<void>
  finish(startMs: number, endMs: number): Promise<WebmSegment | undefined>
  close(): void
}>

// This sandbox preload only transfers a private port; neither ipcRenderer nor app APIs are exposed.
const encoderPreload = `const {ipcRenderer}=require('electron');
ipcRenderer.once('open-science-encoder-port',event=>{
  if(event.ports.length===1)window.postMessage('open-science-encoder-port','*',event.ports);
});`

// This trusted, networkless page only encodes already cropped pixels. It never loads project
// HTML or receives a project URL, origin cookie, filesystem capability, input value or token.
const encoderHtml = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; img-src data: blob:; media-src blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><canvas></canvas><script>
(() => {
  const canvas = document.querySelector('canvas');
  const context = canvas.getContext('2d', {alpha:false});
  let stream, recorder, chunks = [], bytes = 0, writes = 0, limit;
  const initializeEncoder = ({width,height,maxBytes}) => {
    if (!MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) throw Error('VP8 unavailable');
    canvas.width=width; canvas.height=height; limit=maxBytes;
    if (typeof canvas.captureStream !== 'function') throw Error('Canvas streams unavailable');
    return true;
  };
  const start = () => {
    chunks=[];bytes=0;writes=0;
    stream=canvas.captureStream(0);
    if (typeof stream.getVideoTracks()[0].requestFrame !== 'function') throw Error('Manual frames unavailable');
    recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8',videoBitsPerSecond:2000000});
    recorder.ondataavailable=event=>{
      bytes+=event.data.size;
      if(bytes<=limit) chunks.push(event.data);
    };
    recorder.start(250);
  };
  const encodeFrame = async ({png,masks}) => {
    if(!(png instanceof Uint8Array)||png.byteLength>16*1024*1024||!Array.isArray(masks)||masks.length>100)throw Error('Invalid frame');
    const bitmap=await createImageBitmap(new Blob([png],{type:'image/png'}));
    context.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
    context.fillStyle='#000';
    for(const mask of masks) context.fillRect(mask.x,mask.y,mask.width,mask.height);
    if(!recorder) {
      // Let Chromium publish the first painted canvas before creating the capture track. A
      // track created against the initial blank canvas otherwise emits a spurious black frame.
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      start();
    }
    stream.getVideoTracks()[0].requestFrame();writes++;
    if(bytes>limit) throw Error('Video segment capacity exceeded');
    return true;
  };
  const finishSegment = async () => {
    if(!recorder || !writes) return null;
    const current=recorder;
    await new Promise((resolve,reject)=>{
      current.onstop=resolve;current.onerror=()=>reject(Error('Video encoder failed'));current.stop();
    });
    recorder=undefined;
    stream.getTracks().forEach(track=>track.stop());stream=undefined;
    if(bytes>limit) throw Error('Video segment capacity exceeded');
    const blob=new Blob(chunks,{type:'video/webm'});chunks=[];
    return new Uint8Array(await blob.arrayBuffer());
  };
  let connected=false,busy=false;
  const connect=event=>{
    if(connected||event.source!==window||event.data!=='open-science-encoder-port'||event.ports.length!==1)return;
    connected=true;removeEventListener('message',connect);const port=event.ports[0];
    port.onmessage=async event=>{
      const {id,operation,payload}=event.data;
      if(!Number.isSafeInteger(id)||busy){port.postMessage({id,error:true});return;}busy=true;
      try{
        const value=operation==='initialize'?initializeEncoder(payload):operation==='frame'?await encodeFrame(payload):operation==='finish'?await finishSegment():(()=>{throw Error('Unknown operation')})();
        // Electron's renderer-to-MessagePortMain bridge must clone the bounded byte array.
        // Transferring its ArrayBuffer can lose the reply on the supported Electron runtime.
        port.postMessage({id,value});
      }catch{port.postMessage({id,error:true});}finally{busy=false;}
    };port.start();
  };addEventListener('message',connect);
})();</script>`

/** Separate complete WebM segments, not arbitrary timeslice blobs masquerading as seekable files. */
export async function createWebmEncoder(options: {
  width: number
  height: number
  frameRate: number
  maxSegmentBytes?: number
}): Promise<WebmEncoder> {
  const { width, height, frameRate } = options
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 2_073_600 ||
    !Number.isInteger(frameRate) ||
    frameRate < 1 ||
    frameRate > 30
  )
    throw new Error('Invalid browser recording dimensions.')
  const maxSegmentBytes = options.maxSegmentBytes ?? 8 * 1024 * 1024
  if (
    !Number.isInteger(maxSegmentBytes) ||
    maxSegmentBytes < 1024 ||
    maxSegmentBytes > 16 * 1024 * 1024
  )
    throw new Error('Invalid browser recording capacity.')
  const { BrowserWindow, MessageChannelMain, session } = await import('electron')
  const directory = await mkdtemp(join(tmpdir(), 'open-science-encoder-'))
  const preload = join(directory, 'preload.cjs')
  await writeFile(preload, encoderPreload, { mode: 0o600 })
  const isolatedSession = session.fromPartition(`browser-recording-encoder-${randomUUID()}`)
  isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  isolatedSession.setPermissionCheckHandler(() => false)
  isolatedSession.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !details.url.startsWith('data:text/html,') })
  )
  let window: BrowserWindow
  try {
    window = new BrowserWindow({
      show: false,
      focusable: false,
      skipTaskbar: true,
      width: 64,
      height: 64,
      webPreferences: {
        session: isolatedSession,
        preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false
      }
    })
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  const { port1, port2 } = new MessageChannelMain()
  let closed = false,
    nextRequest = 0
  const requests = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  port1.on('message', (event) => {
    const reply = event.data as { id?: unknown; value?: unknown; error?: unknown } | null
    if (!reply || typeof reply.id !== 'number') return
    const pending = requests.get(reply.id)
    if (!pending) return
    requests.delete(reply.id)
    if (reply.error) pending.reject(new Error('Browser recording encoder failed.'))
    else pending.resolve(reply.value)
  })
  port1.start()
  const close = (): void => {
    if (closed) return
    closed = true
    for (const pending of requests.values())
      pending.reject(new Error('Browser recording encoder closed.'))
    requests.clear()
    port1.close()
    if (!window.isDestroyed()) window.destroy()
    void rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
  const request = async (operation: string, payload?: unknown): Promise<unknown> => {
    if (closed || window.isDestroyed() || requests.size)
      throw new Error('Browser recording encoder is unavailable or busy.')
    const id = ++nextRequest
    try {
      return await recordingDeadline(
        new Promise<unknown>((resolve, reject) => {
          requests.set(id, { resolve, reject })
          port1.postMessage({ id, operation, payload })
        })
      )
    } catch (error) {
      // A deadline cannot cancel a renderer's in-flight MediaRecorder operation. Destroy that
      // encoder instead of reusing unknown state or allowing a late reply to reorder segments.
      close()
      throw new Error(`Browser recording encoder ${operation} failed.`, { cause: error })
    } finally {
      requests.delete(id)
    }
  }
  window.once('closed', close)
  try {
    await recordingDeadline(
      window.loadURL(`data:text/html,${encodeURIComponent(encoderHtml)}`),
      10_000
    )
    window.webContents.postMessage('open-science-encoder-port', null, [port2])
    if ((await request('initialize', { width, height, maxBytes: maxSegmentBytes })) !== true)
      throw new Error('Browser recording encoder did not initialize.')
  } catch (error) {
    close()
    throw error
  }
  return {
    async write(png, masks) {
      if (png.byteLength > 16 * 1024 * 1024)
        throw new Error('Browser recording frame exceeds capacity.')
      await request('frame', { png: Uint8Array.from(png), masks })
    },
    async finish(startMs, endMs) {
      if (window.isDestroyed()) return undefined
      const output = await request('finish')
      if (output === null) return undefined
      if (
        !(output instanceof Uint8Array) ||
        !output.byteLength ||
        output.byteLength > maxSegmentBytes
      )
        throw new Error('Browser recording encoder returned invalid media.')
      return {
        bytes: output,
        startMs,
        endMs,
        width,
        height,
        codec: 'vp8',
        frameRate
      }
    },
    close
  }
}
