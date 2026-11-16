import { File, FileArchive, FileCode, FileImage, FileSpreadsheet, FileText, FolderOpen, Presentation, type LucideIcon } from 'lucide-react'
import { createContext, useContext, useEffect, useState } from 'react'
import { uiLanguage } from '../i18n.js'
import { FILE_CARD_KO } from '../lib/threadLangKo.js'
import type { AnswerFile } from '../markdown.js'

// previousFiles() of the conversation the cards are in: a remade file's card links the version before it.
export const PreviousFiles = createContext('')

declare global { interface Window { engramOutputs: { info(id: string): Promise<{ size: number; thumb?: { data: Uint8Array; mime: string } }> } } }

const KINDS: [RegExp, LucideIcon][] = [
  [/\.(xlsx|xls|csv|tsv)$/i, FileSpreadsheet],
  [/\.(pptx|ppt)$/i, Presentation],
  [/\.(png|jpe?g|gif|webp|svg)$/i, FileImage],
  [/\.(py|js|ts|sh|ps1|html)$/i, FileCode],
  [/\.zip$/i, FileArchive],
  [/\.(docx|doc|pdf|md|txt|json|hwpx?)$/i, FileText],
]
const sizeLabel = (bytes: number) => bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1000))} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`

function AnswerFileCard({ file }: { file: AnswerFile }) {
  const [size, setSize] = useState<number>()
  const [url, setUrl] = useState('')
  useEffect(() => {
    let active = true, objectUrl = ''
    void window.engramOutputs?.info(file.id).then(info => {
      if (!active) return
      setSize(info.size)
      if (info.thumb) setUrl(objectUrl = URL.createObjectURL(new Blob([new Uint8Array(info.thumb.data)], { type: info.thumb.mime })))
    }).catch(() => undefined)
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [file.id])
  const Icon = KINDS.find(([pattern]) => pattern.test(file.name))?.[1] ?? File
  const kind = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toUpperCase()
  const windows = navigator.platform.startsWith('Win')
  // The app's language: the page's lang attribute is never set to it (qa146 S03: "Show in Finder" in Korean).
  const ko = uiLanguage() === 'ko'
  const reveal = ko ? (windows ? FILE_CARD_KO.revealWin : FILE_CARD_KO.reveal) : windows ? 'Show in Explorer' : 'Show in Finder'
  const previous = useContext(PreviousFiles).split('\n').find(line => line.startsWith(`${file.id}\t`))?.slice(file.id.length + 1)
  const previousTitle = ko ? FILE_CARD_KO.previousTitle : 'Open the previous version'
  return <div style={{ position: 'relative', maxWidth: '100%' }}>
    <button type="button" className={`chat-file-card answer-file${url ? ' media' : ''}`} title={file.name} data-testid="answer-file"
      onClick={() => window.dispatchEvent(new CustomEvent('engram:open-artifact', { detail: file.id }))}>
      {url && <img src={url} alt={file.name} data-testid="answer-file-thumb" style={{ maxHeight: 160 }} />}
      <span className="chat-file-label"><Icon size={19} strokeWidth={1.8} aria-hidden /><span><strong>{file.name}</strong>{(kind || size !== undefined) && <small data-testid="answer-file-size">{[kind, size === undefined ? undefined : sizeLabel(size)].filter(Boolean).join(' · ')}</small>}</span></span>
    </button>
    <button type="button" className="chat-file-action" data-testid="answer-file-reveal" aria-label={`${reveal}: ${file.name}`} title={reveal}
      style={{ position: 'absolute', right: 6, bottom: 8, display: 'grid', placeItems: 'center', width: 24, height: 24, padding: 0, borderRadius: '50%' }}
      onClick={() => void window.engram.artifactReveal(file.id)}><FolderOpen size={13} aria-hidden /></button>
    {previous && <button type="button" className="link" data-testid="answer-file-previous" aria-label={`${previousTitle}: ${file.name}`} title={previousTitle}
      style={{ display: 'block', margin: '2px 0 0 4px', padding: 0, border: 0, background: 'none', color: 'var(--text-secondary, inherit)', font: 'inherit', fontSize: 12, opacity: 0.7, cursor: 'pointer' }}
      onClick={() => window.dispatchEvent(new CustomEvent('engram:open-artifact', { detail: previous }))}>{ko ? FILE_CARD_KO.previous : '(previous)'}</button>}
  </div>
}

// The files an answer made, as cards under its words: one click opens each.
export function AnswerFiles({ files }: { files: AnswerFile[] }) {
  return <div className="chat-file-list answer-files">{files.map(file => <AnswerFileCard key={file.id} file={file} />)}</div>
}
