// Whether the page panel is shown, shared between the panel itself and the
// composer's globe button that summons it. Folded is a kept preference;
// "wanted" is this session's "open it even though nothing is live yet", so
// pressing the globe with no page open still brings up the panel with its
// address field.

const FOLD_KEY = 'engram.webpane.folded'

interface WebPaneState {
  folded: boolean
  wanted: boolean
}

let state: WebPaneState = { folded: localStorage.getItem(FOLD_KEY) === '1', wanted: false }
const listeners = new Set<() => void>()

function set(next: WebPaneState): void {
  state = next
  localStorage.setItem(FOLD_KEY, next.folded ? '1' : '0')
  for (const one of listeners) one()
}

export const webPane = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  getSnapshot(): WebPaneState {
    return state
  },
  open(): void {
    set({ folded: false, wanted: true })
  },
  fold(): void {
    set({ ...state, folded: true })
  },
  toggle(): void {
    if (state.folded) webPane.open()
    else webPane.fold()
  },
}
