import { File, FileImage, FileSpreadsheet, FileText, Presentation, type LucideIcon } from 'lucide-react'
import type { AnswerFile } from '../markdown.js'

const KINDS: [RegExp, LucideIcon][] = [
  [/\.(xlsx|xls|csv|tsv)$/i, FileSpreadsheet],
  [/\.(pptx|ppt)$/i, Presentation],
  [/\.(png|jpe?g|gif|webp)$/i, FileImage],
  [/\.(docx|doc|pdf|md|txt|json|hwpx?)$/i, FileText],
]

// The files an answer made, as cards under its words: one click opens each.
export function AnswerFiles({ files }: { files: AnswerFile[] }) {
  return <div className="chat-file-list answer-files">{files.map(file => {
    const Icon = KINDS.find(([pattern]) => pattern.test(file.name))?.[1] ?? File
    const kind = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toUpperCase()
    return <button type="button" key={file.id} className="chat-file-card answer-file" title={file.name} data-testid="answer-file"
      onClick={() => window.dispatchEvent(new CustomEvent('engram:open-artifact', { detail: file.id }))}>
      <span className="chat-file-label"><Icon size={19} strokeWidth={1.8} aria-hidden /><span><strong>{file.name}</strong>{kind && <small>{kind}</small>}</span></span>
    </button>
  })}</div>
}
