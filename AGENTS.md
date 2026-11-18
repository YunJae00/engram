# Code rules

- Write no code comments. Keep only license headers and required directives (eslint-disable, ts-expect-error, tool pragmas). `pnpm comment-scan` (part of `pnpm check` and `pnpm check:quick`) fails on new ones.
- Leave no dead, unused or unwired code. Delete what you replace.
- Prefer one simple path over layered special cases.
