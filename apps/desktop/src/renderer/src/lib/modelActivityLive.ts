import { api } from '../api.js'
import { createModelActivity } from './modelActivity.js'

// One store for the renderer's lifetime, fed from the main-process event feed.
export const modelActivity = createModelActivity()

api.onEvent((event) => modelActivity.handleEvent(event))
