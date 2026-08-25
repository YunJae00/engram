import { api } from '../api.js'
import { cometChannel, cometOfChannel, createCometThreads } from './cometThreads.js'

const SELECTED_KEY = 'engram.comets.selected'

// One store for the renderer's lifetime. The view mounts and unmounts with
// the tab; the conversations do not.
export const cometThreads = createCometThreads(localStorage.getItem(SELECTED_KEY))

export function selectComet(id: string | null): void {
  cometThreads.select(id)
  if (id) localStorage.setItem(SELECTED_KEY, id)
  else localStorage.removeItem(SELECTED_KEY)
}

const reloadFromDisk = (id: string) =>
  api
    .botTranscript(id)
    .then((turns) => cometThreads.load(id, turns))
    .catch(() => undefined)

// Disk first, then whatever main is still producing for this comet: a
// renderer that reloaded mid-answer would otherwise never see it land. The
// two reads are sequenced, and a completion that lands between them (noted
// by the listener below) withdraws the seat before it is taken - a seat
// adopted for an answer already finished would never be released.
export async function loadCometThread(id: string): Promise<void> {
  const seenBefore = cometThreads.thread(id).doneSeen
  const turns = await api.botTranscript(id)
  cometThreads.load(id, turns)
  const active = await api.chatActive().catch(() => [] as string[])
  if (active.includes(cometChannel(id)) && cometThreads.thread(id).doneSeen === seenBefore) cometThreads.adopt(id)
}

api.onEvent((event) => {
  const adoptedBefore = 'channel' in event ? cometThreads.thread(cometOfChannel(event.channel)).adopted : false
  const handled = cometThreads.handleEvent(event)
  if (handled) {
    // A seat taken for someone else's send only ever held the reply; the
    // question that produced it is on disk, so disk is the whole story now.
    if (event.type === 'chat:done' && adoptedBefore) void reloadFromDisk(handled)
    return
  }
  if (event.type === 'errand:logged') {
    // A finished errand appends its outcome to the delegating comet's thread.
    const id = cometThreads.getSnapshot().selectedId
    if (id) void reloadFromDisk(id)
    return
  }
  // An answer nobody here was watching (it finished while this renderer was
  // not yet alive) is on disk by the time done is broadcast - unless the
  // person pressed Stop, in which case this is the abort's own echo and disk
  // holds nothing of the exchange the thread already settled by itself.
  if (event.type === 'chat:done' || event.type === 'chat:error') {
    const id = cometOfChannel(event.channel)
    if (!id || !cometThreads.getSnapshot().threads[id]) return
    cometThreads.noteDone(id)
    if (cometThreads.thread(id).stopped) {
      cometThreads.clearStopped(id)
      return
    }
    void reloadFromDisk(id)
  }
})
