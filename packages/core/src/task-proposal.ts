// Turning a job that was just done into a button worth pressing again. The
// ask itself is the wrong label for it: "여기 들어가서 확인만 해줘봐" names this
// morning, not the work, and a row of buttons carrying whole sentences is
// unreadable within a week. So the work is restated - a short name, the job
// written as an instruction that will still make sense next month, and one
// line saying what pressing it would do - and the person is shown all three
// before anything is kept.

export interface TaskProposal {
  // What the button says. Short enough to read in a row of them.
  name: string
  // The instruction the button carries: the same job, with this morning's
  // particulars kept only where they are the job.
  goal: string
  // What pressing it would do, in one sentence, in the person's language.
  does: string
}

export const PROPOSAL_TOKENS = 220
export const NAME_CHARS = 32
export const GOAL_CHARS = 240
export const DOES_CHARS = 160

export function proposalPrompt(exchange: { user: string; answer: string; steps: readonly string[] }): string {
  return [
    'JOB: COMET-KEEP',
    'A job was just done for the person. They may want it as a button they can press again. Write the button.',
    'Answer as three lines and nothing else:',
    'NAME: a short label, at most 5 words, naming the WORK - never the words they happened to type, never a date',
    'GOAL: the same job as one instruction you could be given again next month, specific enough to run without asking',
    'DOES: one sentence saying what pressing it would do',
    'Write all three in the language the person wrote in. If the job is not worth repeating - a one-off lookup, a question about this conversation - write only: NONE',
    '',
    `They asked: ${exchange.user.slice(0, 600)}`,
    ...(exchange.steps.length ? ['Steps taken:', ...exchange.steps.slice(0, 12).map((step) => `- ${step.slice(0, 120)}`)] : []),
    `You answered: ${exchange.answer.slice(0, 400)}`,
  ].join('\n')
}

function field(raw: string, key: string): string {
  const line = raw.split('\n').find((one) => one.trim().toUpperCase().startsWith(`${key}:`))
  return line ? line.slice(line.indexOf(':') + 1).trim().replace(/^["'“”]|["'“”]$/g, '') : ''
}

// A model that answered in prose, or refused, leaves nothing to keep: the
// caller falls back to what it already had rather than showing a button
// labelled with half a sentence.
export function parseProposal(raw: string): TaskProposal | null {
  if (/^\s*NONE\s*$/im.test(raw) && !/^\s*NAME:/im.test(raw)) return null
  const name = field(raw, 'NAME')
  const goal = field(raw, 'GOAL')
  const does = field(raw, 'DOES')
  if (!name || !goal) return null
  return {
    name: name.slice(0, NAME_CHARS),
    goal: goal.slice(0, GOAL_CHARS),
    does: (does || goal).slice(0, DOES_CHARS),
  }
}

// "The language this was written in" is not something a model reliably reads
// off a short ask, and the pages it goes on to read are often in another one:
// an English request came back answered in French because the words the turn
// filled up with outweighed the two lines that asked for it (measured). Where
// the script says plainly which language it is, the instruction names it.
export function answerLanguageLine(task: string): string {
  const hangul = /[\uac00-\ud7a3]/.test(task)
  const kana = /[\u3040-\u30ff]/.test(task)
  const han = /[\u4e00-\u9fff]/.test(task)
  const latin = /[a-z]/i.test(task)
  const named = hangul ? 'Korean' : kana ? 'Japanese' : han && !latin ? 'Chinese' : latin && !han ? 'English' : ''
  return named
    ? `Write your answer in ${named}, whatever language the pages you read are in.`
    : 'Write your answer in the language this task is written in, whatever language the pages you read are in.'
}
