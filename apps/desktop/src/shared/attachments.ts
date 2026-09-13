export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024
export const ATTACHMENT_MAX_COUNT = 8
export const ATTACHMENT_ACCEPT = '.txt,.md,.csv,.tsv,.json,.log,.docx,.xlsx,.xlsm,.pptx,.pdf,.hwpx,.png,.jpg,.jpeg,.webp,.gif'

export function attachmentError(name: string, size: number): string | null {
  const extension = /\.[^.]+$/.exec(name)?.[0]?.toLowerCase()
  if (!name || name.length > 180 || /[/\\<>:"|?*]/.test(name) || Array.from(name).some(char => char.charCodeAt(0) < 32)) return 'The attachment filename is invalid.'
  if (!extension || !ATTACHMENT_ACCEPT.split(',').includes(extension)) return 'Attach text, PDF, Office documents, or PNG, JPEG, WebP and GIF images.'
  if (!Number.isSafeInteger(size) || size <= 0) return 'This file is empty.'
  return size > ATTACHMENT_MAX_BYTES ? 'Each attachment must be 20 MB or smaller.' : null
}
