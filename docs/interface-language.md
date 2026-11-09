# Interface language

Engram's interface ships in Korean and English. The `uiLanguage` setting is `system`, `ko` or `en` and defaults to `system`. `system` reads the OS locale: any `en*` locale shows English, and every other locale, Japanese included, shows Korean. An explicit `ko` or `en` overrides the OS locale. A missing or unrecognized value counts as `system`; main normalizes such a saved value to `system` when it reads the settings file.

At startup the renderer reads the saved choice and then follows `settings:changed` events. `t()` resolves the language on every call, so the next render uses the new language; already mounted components are not forced to render again.

Interface strings live in two tables with the same keys and the same `{placeholders}`: English in `apps/desktop/src/renderer/src/i18n.ts`, and Korean in `apps/desktop/src/renderer/src/i18n-ko.ts`, which assembles the `i18n-ko-*.ts` parts. The Korean table is typed `Record<StringKey, string>`, so a missing or extra key fails typecheck. Every new interface string is added to both tables. Korean literals in renderer source belong only in `i18n-ko.ts`, `i18n-ko-*.ts` and the existing `lib/threadLangKo.ts` conversation-language exception.

Labels inside a conversation follow the conversation language, not `uiLanguage`: `threadT(lang)` reads through `tIn(lang, key, vars)`, so an English conversation reads the English table and a Korean one reads `threadLangKo.ts` first, then the Korean table.

Renderer date formatting still passes a fixed locale: sidebar dates, date tooltips, routine timestamps and errand timestamps explicitly use `en-US` while retaining the user's local time zone. `uiLocale()` in `i18n.ts` returns `ko-KR` or `en-US` for the resolved language; a follow-up item switches those date call sites to it.

Conversation titles, messages, imported bookmark names and saved notes are user content. They retain their original language. AI replies follow the user's language; the interface does not translate that content.

The source audit covers renderer text, desktop/core source, native control policies and locale-dependent formatting. Korean text in parsers, search normalization, sensitive-content detection, cancellation and submission guards is input recognition, not interface copy. Removing it would weaken multilingual support and safeguards. Multilingual test fixtures and evaluation prompts also remain intact.

The interface-language test checks renderer source for Korean literals outside the allowed files and for implicit date locales. Memory-writing instructions use language-neutral guidance rather than enforcing a Korean-specific writing style.
