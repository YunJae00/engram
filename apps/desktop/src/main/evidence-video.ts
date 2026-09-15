import { BrowserWindow } from 'electron'

// Encode only host-supplied masked frames. The encoder has no page, microphone or desktop access.
export async function videoEncoder(size = { width: 1280, height: 720 }) {
  const scale = Math.min(1, 1280 / size.width, 720 / size.height)
  const width = Math.max(2, Math.floor(size.width * scale / 2) * 2)
  const height = Math.max(2, Math.floor(size.height * scale / 2) * 2)
  const window = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  try {
    await window.loadURL('data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src %27none%27; img-src data: blob:; media-src blob:"><canvas></canvas>')
    await window.webContents.executeJavaScript(`(() => {
      const canvas = document.querySelector('canvas'); canvas.width = ${width}; canvas.height = ${height};
      const ctx = canvas.getContext('2d');
      const track = new MediaStreamTrackGenerator({ kind: 'video' }); const writer = track.writable.getWriter();
      const stream = new MediaStream([track]); const started = performance.now();
      const mimeType = 'video/mp4;codecs=avc1.42001f';
      if (!MediaRecorder.isTypeSupported(mimeType)) throw new Error('MP4/H.264 recording is unavailable on this system. No recording was started.');
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1200000 });
      const chunks = []; let bytes = 0; let failure = '';
      recorder.ondataavailable = event => { bytes += event.data.size; if (bytes > 30000000) { failure = 'Recording exceeded 30 MB'; if (recorder.state !== 'inactive') recorder.stop(); } else chunks.push(event.data); };
      recorder.onerror = () => { failure = 'Video encoding failed'; };
      window.addFrame = async source => { if (failure || recorder.state !== 'recording') throw new Error(failure || 'Recording stopped'); const image = new Image(); image.src = source; await image.decode(); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); const scale = Math.min(canvas.width / image.width, canvas.height / image.height); ctx.drawImage(image, 0, 0, image.width * scale, image.height * scale); const frame = new VideoFrame(canvas, { timestamp: Math.round((performance.now() - started) * 1000) }); try { await writer.write(frame); } finally { frame.close(); } };
      window.finish = () => new Promise((resolve, reject) => { recorder.onstop = async () => { stream.getTracks().forEach(track => track.stop()); if (failure) { reject(new Error(failure)); return; } const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = () => reject(new Error('Video could not be read')); reader.readAsDataURL(new Blob(chunks, { type: mimeType })); }; if (recorder.state === 'inactive') { reject(new Error(failure || 'Recorder is inactive')); return; } recorder.stop(); });
      recorder.start(1000);
    })()`)
  } catch (error) { window.destroy(); throw error }
  return {
    async frame(data: Buffer) { if (window.isDestroyed()) throw new Error('Recording window closed'); await window.webContents.executeJavaScript(`window.addFrame(${JSON.stringify(`data:image/png;base64,${data.toString('base64')}`)})`) },
    async finish(): Promise<Buffer> {
      const timeout = setTimeout(() => { if (!window.isDestroyed()) window.destroy() }, 10000)
      try { return Buffer.from(await window.webContents.executeJavaScript('window.finish()') as string, 'base64') }
      finally { clearTimeout(timeout); if (!window.isDestroyed()) window.destroy() }
    },
    close() { if (!window.isDestroyed()) window.destroy() },
  }
}
