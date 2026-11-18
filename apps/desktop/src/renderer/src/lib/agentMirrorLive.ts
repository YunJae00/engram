import { api } from '../api.js'
import { createAgentMirror } from './agentMirror.js'

export const agentMirror = createAgentMirror({
  watch: (on) => void api.agentWatch(on).catch(() => {}),
  ask: () => api.agentState(),
})

api.onEvent((event) => agentMirror.handleEvent(event))
