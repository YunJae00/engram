import { workBlocks } from '../lib/pendingStatus.js'
import { Answer } from './Answer.js'

// In a Korean conversation a note the model made to itself in English ("Now I have solid sources") is not something it said to the person.
export function CometWork({ busy, lines, lang }: { busy: boolean; lines: string[]; lang?: 'en' | 'ko' }) {
  const said = workBlocks(lines).filter(block => block.type === 'you' || (block.type === 'said' && (lang !== 'ko' || /[\uac00-\ud7a3]/.test(block.text))))
  if (!said.length) return null
  return <div className={busy ? 'comet-work' : 'comet-work done'} data-testid={busy ? 'comet-work' : 'comet-work-done'}>
    <ol className="comet-work-lines" data-testid="bots-work-lines">
      {said.map((block, index) => block.type === 'you'
        ? <li key={index} className="comet-work-line you"><span className="chat-user-text">{block.text}</span></li>
        : block.type === 'said' && <li key={index} className="comet-work-line said"><Answer text={block.text} compact /></li>)}
    </ol>
  </div>
}
