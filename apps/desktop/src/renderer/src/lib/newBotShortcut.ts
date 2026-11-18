export function isNewBotShortcut(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'isComposing' | 'keyCode'>,
): boolean {
  return (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey
    && e.key.toLowerCase() === 'n' && e.isComposing !== true && e.keyCode !== 229
}
