# Rules for agents in this repo

- Write no code comments. Only license headers and required directives (eslint-disable, @ts-expect-error, tool pragmas) are allowed. `pnpm run comment-scan` fails otherwise.
- Leave no dead, unused or unwired code. Delete what you replace. `pnpm run dead-scan` fails otherwise.
- Prefer one simple path over layered special cases. Do not add checks, repairs or fallbacks after the model's answer; see docs/spec/ANSWER-SPEC.md section 5.
- Do not match Korean words with regexes or lists in product code. Fix the cause in prompts, context or tools.
- Never delete or skip tests. Update them to the spec.
- Never weaken send, delete, purchase, sign-in or OS permission gates.
