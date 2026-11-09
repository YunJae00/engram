import type { StringKey } from './i18n'
import { ko1 } from './i18n-ko-1'
import { ko2 } from './i18n-ko-2'

export const ko: Record<StringKey, string> = { ...ko1, ...ko2 }
