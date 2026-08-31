import { api } from '../api.js'
import { createAgentMirror } from './agentMirror.js'

// One store for the renderer's lifetime, fed from the main-process event
// feed. Asking for the stream and letting it go travels with whether any
// view is subscribed, not with which view is mounted.
export const agentMirror = createAgentMirror((on) => {
  void api
    .agentWatch(on)
    .then((state) => {
      if (on) agentMirror.open(state.on, state.url)
    })
    .catch(() => {})
})

api.onEvent((event) => agentMirror.handleEvent(event))
