export function isNewBotShortcut(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'isComposing' | 'keyCode'>,
): boolean {
  // keyCode 229 is the IME-processing key some engines send without isComposing
  return (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey
    && e.key.toLowerCase() === 'n' && e.isComposing !== true && e.keyCode !== 229
}
