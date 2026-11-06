import { workBlocks } from '../lib/pendingStatus.js'
import { Answer } from './Answer.js'

export function CometWork({ busy, lines }: { busy: boolean; lines: string[] }) {
  const said = workBlocks(lines).filter(block => block.type === 'said' || block.type === 'you')
  if (!said.length) return null
  return <div className={busy ? 'comet-work' : 'comet-work done'} data-testid={busy ? 'comet-work' : 'comet-work-done'}>
    <ol className="comet-work-lines" data-testid="bots-work-lines">
      {said.map((block, index) => block.type === 'you'
        ? <li key={index} className="comet-work-line you"><span className="chat-user-text">{block.text}</span></li>
        : block.type === 'said' && <li key={index} className="comet-work-line said"><Answer text={block.text} compact /></li>)}
    </ol>
  </div>
}
