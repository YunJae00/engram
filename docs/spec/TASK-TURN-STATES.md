# Task turn states

One task turn after the final-delivery cut: the first draft is delivered as soon as the model writes it, and the task may then run hidden follow-up turns (re-check, readback, continuation). This table is every phase crossed with every event, and what must hold. `apps/desktop/test/task-turn-states.test.ts` walks every row by id.

## Owners

- **Stop line:** written only by `stopper` (`apps/desktop/src/main/turn-stop.ts`). It decides from one value taken when the stop arrives: was work live in the room (a running chat turn or a queued/running/waiting task)? It stops the work, waits for the running turn to end, then stores and shows one stop line. A second stop while the first is still running joins the first. No turn code writes a stop line.
- **Failure line (sign-in, usage):** a turn the person sees (`turn.quiet` unset) writes its own line in `handleChatSend` and reports `errored` or `asked`; the task adds nothing. A hidden turn (`turn.quiet`) writes nothing and throws or returns an empty outcome; the task runner alone decides, from whether an answer was already delivered: keep it and end `done`, or show and store one line through `closeTask` and end `failed`.

## Table

Phases: **first** = the person's own turn before any answer; **booked** = answer delivered, post-answer bookkeeping still running in the same turn; **between** = task live, no turn running (waiting); **hidden-before** = hidden turn, no answer delivered yet; **hidden-after** = hidden turn after the answer was delivered (re-check before its model call or during it).

"Stored" is the bot transcript after the room reloads.

| id | phase | event | person sees | stored | task |
|---|---|---|---|---|---|
| S1 | first, before model call | stop | one stop line | ask, stop word, stop line | stopped |
| S2 | first, model call | stop | one stop line | ask, stop word, stop line | stopped |
| S3 | booked | stop | answer, then one stop line | ask, answer, stop word, stop line | stopped |
| S4 | between | stop | one stop line | ask, question, stop word, stop line | stopped |
| S5 | hidden-after, running | stop | answer, then one stop line | ask, answer, stop word, stop line | stopped |
| S6 | any | stop twice at once (message + button) | one stop line | one stop line | stopped |
| S7 | nothing live | stop | nothing | nothing added | unchanged |
| S8 | first, English thread | stop button, no words | `Stopped.` | ask, `Stopped.` | stopped |
| F1 | hidden-after | usage limit | answer only | ask, answer | done, result = answer |
| F2 | hidden-after | signed out / engine unavailable | answer only | ask, answer | done, result = answer |
| F3 | hidden-after | thrown error (also desktop unavailable) | answer only | ask, answer | done, result = answer |
| F4 | hidden-after | empty reply | answer only | ask, answer | done, result = answer |
| F5 | hidden-before | usage limit | one usage line | ask, usage line | failed |
| F6 | hidden-before | signed out / engine unavailable | one sign-in line | ask, sign-in line | failed |
| F7 | hidden-before | thrown error | one usage line | ask, usage line | failed |
| F8 | hidden-before | empty reply | one usage line | ask, usage line | failed |
| F9 | first | any failure | the turn's own one line | ask, that line | failed or waiting; the task adds no line |
