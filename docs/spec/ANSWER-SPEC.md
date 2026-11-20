# Answer spec

## 1. Words
- Person: the user. Korean speaker, not a developer.
- Thread: one chat. The person's main thread is the primary bot's chat.
- Teammate: a persistent bot with a plain name, a role in a few words, its own memory. All teammates are equal. There is one team.
- Lead: the model step that speaks in a thread. In the main thread it speaks for the team. In a teammate's own thread it is that teammate.
- Job: work started from a thread that takes more than one model step. It has parts. Each part belongs to the lead or to a teammate.
- Hand-back: what a teammate returns for its part. Never shown to the person as is.
- Draft: the text the lead's model writes for the person.

## 2. The one path
Every message the person sends, in any thread, idle or mid-work, takes this path. There is no other path.

1. Store the message in the thread.
2. Ack. If the message will start work, one quick model call writes one Korean sentence of at most 60 characters that names the first concrete step. It is posted as is. If the message is a greeting, a thanks or a question the lead answers in one step, there is no ack: the answer itself is the first text.
3. Lead step. The lead model gets the context in section 3 and the tools in section 4. It streams text and calls tools. Text it streams is the draft, and it is shown as it streams.
4. Tool calls that finish fast run inline. Work that takes longer runs as a job in the background. The lead's step ends. The input stays usable.
5. A new message while a job runs is injected into the job's lead at its next step. The host aborts the lead's in-flight model call so the message is read at once. Tools already running keep running. The lead decides: answer an aside, change the job's scope, or stop.
6. When every part of a job has handed back, or the job's due time arrives, the host starts one lead step with the hand-backs. The lead writes the one result in the same thread.
7. The host renders the draft (section 5) and stores it. Nothing else touches it.

## 3. What the lead sees on every step
Built by one function. Nothing is added elsewhere.
- The thread's messages, newest last, with earlier turns summarized when long. Unrelated earlier turns are kept: a later "그 여행", "그거 말고" must resolve from them.
- Today's date, weekday and time zone, and a 14-day calendar (date + weekday). The model resolves "이번 주말", "다음 주 목요일" from it. It never explains how it worked out a date.
- The person's remembered facts (latest value only).
- The team: each teammate's name, role, and what they are doing right now, from live state.
- Live jobs in this thread: their parts, who has each, state, due time, hand-backs so far.
- The job's ask card when writing a result (section 6).
- Source table: every page and search row a tool returned in this job, with title, address, date and a short excerpt. The model copies an address from it when it links a source.
- Files the person named or the job created, by display name.
It never sees ids, file-system paths, tool-internal states or other teammates' raw logs.

## 4. Tools
One menu for every lead step. The model picks. The host makes no tool call for the model.
- search_web, open_page: web reading. Results go into the source table.
- read_file, list_files, move_file, write_file: in-box files only.
- office_build, office_edit: Word, PowerPoint, Excel. A build verifies its own file and returns problems to the model as tool output.
- assign({parts:[{who?, brief, want?, period?}], then?}): starts a job. `who` is a teammate name, or empty for an unnamed helper. A name not on the team adds that teammate. `want` is a count when the ask counts. `period` is the date range the items must fall in. `then` hands one part's result to another teammate.
- steer({job, add?, replace?}): changes a running job's scope.
- stop(): stops every job in the thread and every teammate part of them.
- team({add?, rename?, remove?, restore?}): changes the team.
- schedule({add?|list?|remove?}): recurring work.
- remember({subject, value}): saves a fact. Same subject replaces the old value.
- send / post / message / delete-file / buy: these go through the approval gate (section 9).

## 5. What the host may do to a draft
Exactly these three things. Anything else is a spec violation.
1. Stream it into the thread as it arrives.
2. Split it into bubbles where the model wrote a blank line between bubbles.
3. Attach a file card for each file a tool created or changed in this job.
The host never writes, deletes, reorders, rewords or templates a sentence, and never adds, removes or changes a link. A source is a normal Markdown link the model writes itself, with an address copied from its source table. The host runs no model call that reads the draft.
Two fixed lines are the only host text, from the locale catalog: the stop line ("멈췄어요.") and the sign-in/usage line when no model can answer.

## 6. Jobs, teammates and the one result
- Parts run at the same time. A handoff (`then`) starts the next part when the first hands back, with no input from the person.
- A teammate runs the same loop as the lead, as itself (name, role, memory), with the reading tools and hand_back. It never writes to the person's thread.
- hand_back({items:[{text, sources:[address], date?}], status: done|partial|nothing}) is the teammate's last call. The tool keeps the teammate working when the part is not finished and time is left:
  - fewer items than `want`, or status nothing, while more than one search round fits before due → the tool returns "keep looking" with the time left, and the teammate searches again with new words taken from the person's ask (broader terms, other sources, the asked period).
  - an item with `period` set and a date outside it is refused with the reason.
  - items without a source are refused.
  These are input rules of a tool, checked exactly. They never change text.
- Ask card: when the lead starts a job it writes the ask card: what was asked, the count, the period, and every constraint in the person's words (tone, language, length, "무릎 때문에 걷기 적게", "정중한 영어"). Steering edits the card. The result step gets the card verbatim.
- The result step: one lead step writes one draft from the card, the hand-backs and the source table. It attributes each part by teammate name. It writes counts and team facts from the data it was given, not from memory.
- Due time: every job has a due time from the person's ask class (section 10). At due time the result is written with what exists. A part still working is said in its row in one plain sentence ("리니어(도윤): 아직 찾는 중이에요. 끝나면 이어서 올릴게요.") and posted when it lands.
- Background: a job started with "맡겨" does not block. Its result arrives in the same thread when done.
- Team record: when a job ends, one dated line goes to each teammate's memory and to the team record. No model call.

## 7. Stop and steering
- "멈춰", "그만", "stop" and the other exact stop words stop every job in the thread within 3 s, teammates included. The host posts the stop line. Nothing is marked failed. No banner.
- Any other wording that means stop reaches the lead, which calls stop().
- A mid-work message that adds or replaces scope is applied to the running job (steer) and lands in the same one result. The lead says one short line back ("대구도 넣을게요.").
- A mid-work aside is answered at once in the same thread. The job keeps running.
- A mid-work complaint or thanks gets at most two warm sentences. The job keeps running.

## 8. Voice
- Korean in a Korean thread. 해요체 only. No 반말, no 합쇼체 mix.
- A person on a messenger: short bubbles, warm, plain. At most 3 bubbles per turn (ack + 2).
- Answer first. A table when comparing. A source as a Markdown link the model writes itself, with the page's address copied exactly; never a source name alone.
- No process narration, no step stream, no recap of steps, no "요청하신 작업이 완료되었습니다", no "무엇을 도와드릴까요", at most one 죄송.
- Progress: at most one short line when a part the person cares about finishes ("셋 중 둘은 끝났어요.").
- Decide, don't ask. When a choice is open, make it, say it in a few words, and offer at most one short next step.
- Memory is silent. Never say it remembered, saved or searched memory. A correction replaces the old fact everywhere.
- No jargon: no tool names, ids, paths, states, codes, model names, JSON, or the words 에이전트, 세션, 턴, 토큰, 프롬프트, 런타임, 컨텍스트. Teammates are called by name or "팀".
- No "보고" wording, no titles, no company words.
These rules live in one system prompt file. They are not enforced by host checks.

## 9. Gates (unchanged by this spec)
Ask before: sending, posting or messaging anyone; deleting the person's files; buying; sign-in and OS permission prompts. Never ask before reading, writing or moving in-box files the person named or the job's own outputs. Never offer A/B choices. The gate code is listed in the factory design (section d) and is never weakened.

## 10. Time caps
first visible text ≤ 2 s; simple answer done ≤ 8 s; one lookup ≤ 20 s; file sort ≤ 30 s; split research ≤ 35 s (with a mid-work add ≤ 40 s); office doc ≤ 60 s (summary ≤ 20 s, edit ≤ 30 s); stop ≤ 3 s; team change ≤ 5 s (second add ≤ 8 s); status ≤ 3 s; handoff chain ≤ 45 s; what the team did ≤ 15 s. A job's due time is its cap minus the time one result step needs.

## 11. Models
- Ack: the quick tier (today `engine.quick`, haiku, effort low).
- Lead and teammates: the smart tier (today `smart` → sonnet), effort by job size.
- No other model call is on the answering path. No judge, checker, rewriter or summarizer reads a draft.

## 12. Properties the path produces by construction
- Counted lists are full and not padded: hand_back keeps a teammate searching until `want` is met or time runs out; off-period and unsourced items are refused at the tool; a short count is said only at due time, with the missing count.
- Summaries match their data and keep the ask's constraint: the result step writes from the ask card, live team state and the hand-backs, not from transcript memory.
- Empty results are retried, not handed back as a question: hand_back refuses `nothing` while time is left.
- No host step can delete, blank or template over the model's cited words: section 5 has no such operation.
- No repair can undo a property of the draft: there are no repairs.
