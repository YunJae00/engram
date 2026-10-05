import { BrowserWindow } from 'electron'

// Encode only host-supplied masked frames. The encoder has no page, microphone or desktop access.
export async function videoEncoder(size = { width: 1280, height: 720 }, bitsPerSecond = 1_200_000) {
  const scale = Math.min(1, 1280 / size.width, 720 / size.height)
  const width = Math.max(2, Math.floor(size.width * scale / 2) * 2)
  const height = Math.max(2, Math.floor(size.height * scale / 2) * 2)
  const window = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const close = () => { if (!window.isDestroyed()) window.destroy() }
  const bounded = async <T>(work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { close(); reject(new Error('Recording encoder timed out')) }, 10_000)
      })])
    } finally { clearTimeout(timer) }
  }
  try {
    await bounded(window.loadURL('data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src %27none%27; img-src data: blob:; media-src blob:"><canvas></canvas>'))
    await bounded(window.webContents.executeJavaScript(`(() => {
      const canvas = document.querySelector('canvas'); canvas.width = ${width}; canvas.height = ${height};
      const ctx = canvas.getContext('2d');
      const track = new MediaStreamTrackGenerator({ kind: 'video' }); const writer = track.writable.getWriter();
      const stream = new MediaStream([track]); const started = performance.now();
      const mimeType = 'video/mp4;codecs=avc1.42001f';
      if (!MediaRecorder.isTypeSupported(mimeType)) throw new Error('MP4/H.264 recording is unavailable on this system. No recording was started.');
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: ${Math.round(bitsPerSecond)} });
      const chunks = []; let bytes = 0; let failure = '';
      recorder.ondataavailable = event => { bytes += event.data.size; if (bytes > 30000000) { failure = 'Recording exceeded 30 MB'; if (recorder.state !== 'inactive') recorder.stop(); } else chunks.push(event.data); };
      recorder.onerror = () => { failure = 'Video encoding failed'; };
      const hold = async () => { const frame = new VideoFrame(canvas, { timestamp: Math.round((performance.now() - started) * 1000) }); try { await writer.write(frame); } finally { frame.close(); } };
      window.addFrame = async source => { if (failure || recorder.state !== 'recording') throw new Error(failure || 'Recording stopped'); const image = new Image(); image.src = source; await image.decode(); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); const scale = Math.min(canvas.width / image.width, canvas.height / image.height); ctx.drawImage(image, 0, 0, image.width * scale, image.height * scale); await hold(); };
      // The encoder holds back its newest frame; the last picture is repeated so a short recording is not lost.
      window.finish = async () => { if (!failure && recorder.state === 'recording') { for (let i = 0; i < 6 && (i < 2 || bytes === 0); i++) { await hold(); await new Promise(resolve => setTimeout(resolve, 1000)); recorder.requestData(); await new Promise(resolve => setTimeout(resolve, 100)); } } return stop(); };
      const stop = () => new Promise((resolve, reject) => { recorder.onstop = async () => { stream.getTracks().forEach(track => track.stop()); if (failure) { reject(new Error(failure)); return; } const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = () => reject(new Error('Video could not be read')); reader.readAsDataURL(new Blob(chunks, { type: mimeType })); }; if (recorder.state === 'inactive') { reject(new Error(failure || 'Recorder is inactive')); return; } recorder.stop(); });
      recorder.start(1000);
    })()`))
  } catch (error) { close(); throw error }
  return {
    async frame(data: Buffer, mime: 'image/png' | 'image/jpeg' = 'image/png') { if (window.isDestroyed()) throw new Error('Recording window closed'); await bounded(window.webContents.executeJavaScript(`window.addFrame(${JSON.stringify(`data:${mime};base64,${data.toString('base64')}`)})`)) },
    async finish(): Promise<Buffer> {
      try { return Buffer.from(await bounded(window.webContents.executeJavaScript('window.finish()')) as string, 'base64') }
      finally { close() }
    },
    close,
  }
}
