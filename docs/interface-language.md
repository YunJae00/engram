# Interface language

Engram's shipped interface uses English. Sidebar dates, date tooltips, routine timestamps and errand timestamps explicitly use `en-US`, while retaining the user's local time zone.

Conversation titles, messages, imported bookmark names and saved notes are user content. They retain their original language. AI replies follow the user's language; the interface does not translate that content.

The source audit covers renderer text, desktop/core source, native control policies and locale-dependent formatting. Korean text in parsers, search normalization, sensitive-content detection, cancellation and submission guards is input recognition, not interface copy. Removing it would weaken multilingual support and safeguards. Multilingual test fixtures and evaluation prompts also remain intact.

The interface-language test checks renderer source for Korean literals and implicit date locales. Memory-writing instructions use language-neutral guidance rather than enforcing a Korean-specific writing style.
