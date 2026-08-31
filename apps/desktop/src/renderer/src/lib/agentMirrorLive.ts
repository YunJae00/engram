import { api } from '../api.js'
import { createAgentMirror } from './agentMirror.js'

// One store for the renderer's lifetime, fed from the main-process event
// feed. Asking for frames travels with whether anything is showing the
// picture, not with which view happens to be mounted.
export const agentMirror = createAgentMirror({
  watch: (on) => void api.agentWatch(on).catch(() => {}),
  ask: () => api.agentState(),
})

api.onEvent((event) => agentMirror.handleEvent(event))
