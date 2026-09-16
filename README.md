# Engram

[![CI](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)

**A second brain that keeps your memories on your machine.**

Engram watches what you work on, files it into a plain-markdown vault, and organizes it the way human memory works — memories strengthen with use, fade without it, associate by meaning, and consolidate while you're away. Your vault, the embeddings that connect it and every judgement about it stay on this computer; the sentences are written by the AI you already subscribe to, signed in with your own account.

No Engram account. No Engram subscription.

## How it works

**Capture.** Drop a thought into the composer, drop a file on the window, or just work — Engram can (with your consent, folder by folder) notice saved documents (`docx` / `xlsx` / `pptx` / `pdf` / `hwpx`), your browser trail (titles only, from the browser's local history), and transcripts of AI CLI sessions (Claude Code, Codex). Everything lands in an inbox as plain text.

**The librarian.** A background worker absorbs the inbox into structured markdown notes — titled, tagged with decay class and salience, linked to related memories, deduplicated, superseded when a newer note replaces an older claim. It settles its own questions; you are almost never asked anything. Sentence-writing is done by the brain you signed in to — Claude or ChatGPT, through the vendor's own runtime, billed to your own plan.

**The memory model.** Judgment is embeddings, prose is the LLM, hygiene is rules:

- **Activation** — every note carries a retrieval strength computed with the ACT-R base-level equation (recency + frequency of actual use). It drives star brightness, list dimming, and retrieval ranking. Frequently-used memories stay vivid for months; untouched ones cool but are never deleted.
- **Association** — a similarity fabric (bge-m3 embeddings, incremental neighbor cache) links notes that live close in meaning-space, groups them into topics even before any explicit link exists, and draws faint threads between them in the sky.
- **Re-exposure warmth** — a new capture landing near an old note re-warms it, the way hearing a topic again refreshes your memory of it.
- **Hebbian co-recall** — memories retrieved together wire together; retrieval spreads along those synapses.
- **Consolidation** — during background sweeps, clusters held together only by meaning get a synthesized hub note, turning resemblance into structure.
- **Resurfacing** — memories with high storage strength but sinking retrieval strength appear as a quiet list in the Today sheet. Opening one is the reinforcement.

**The vault.** Everything is markdown files with frontmatter, in a folder you own. Sync it with git if you like. Derived state (embeddings, caches) lives in a separate directory and can always be rebuilt.

## Surfaces

- **Mission Control** — work in one, two, or four persistent panels, each pairing a comet conversation with its live web view. Finished work stays in place; use a panel's title to replace it or start another chat. Moving pages stream directly to the canvas, then settle into a lossless high-resolution frame. Hidden panels stop encoding without stopping their work.
- **Comets** — small helpers, each with a charter and its own conversation over the same memory. Work you repeat is saved on a comet as a task and run with one press.
- **Cosmos** — every memory a star; brightness is memory strength, constellations are topics, gold halos mark recent recall. Chat is docked on its right edge: ask your memory, with hybrid retrieval (lexical + semantic + spreading activation) and instant source cards.
- **Brain** — topics as readable pages, warm topics first, with the librarian's synthesis on top.
- **List / Timeline** — the raw memories, filterable.
- **Computer** (Windows, Claude connection) — enable computer use in Settings to let a comet work in an open app with your real mouse and keyboard. A screen glow and status pill identify the active connection; moving the mouse or typing pauses control, and work can resume after your hands are still. Esc or Stop ends control for the turn. Sign-in pages, passwords and security settings require manual interaction.
- **Routines** — the pages and clicks you walk every day, saved once and replayed verbatim in a dedicated browser profile. No model runs, so a routine works on a machine too busy for inference; what it reads comes back as a review card, and one that types into a page asks before it repeats itself.
- **MCP server** — connect AI tools to your memory: context injection, search, capture, and graph traversal over the Model Context Protocol.

## What it reads, and what never leaves

Engram has no hosted vault service. Local capture and indexing stay on your machine; the context needed for an AI request is sent to your selected provider. Browser actions access the websites you choose.

| source | what is read | opt-in |
|---|---|---|
| the composer | what you type | always on |
| dropped files | the text of the file | per drop |
| document folders | the *changed lines* of documents you save there | per folder, off by default |
| browser history | page **titles and hosts** from the browser's own local history — never URLs, never content; login/auth pages are filtered out | rides with the desk journal (below); off when it is off |
| AI CLI sessions | transcripts of Claude Code / Codex sessions on this machine | off by default |
| active window | app name and window title, for the "at the desk today" line — the desk journal | **on by default**, announced on first run, one switch in Settings/tray |

Everything lands as markdown in a folder you choose. `private/` is never passed to any engine. Derived state (embeddings, caches) lives under `.engram/` and can be deleted at any time.

## Install

Grab the installer from [Releases](../../releases). On first run you sign in to the brain you already pay for — Claude or ChatGPT — with your own account; the embedding model that connects your memories downloads once and runs on this machine.

Currently supported: **Windows**. macOS support is planned; its packaging code remains available but releases do not publish macOS installers. Linux artifacts are not published.

The Windows installer is not yet code signed. SmartScreen may warn — **More info → Run anyway**. On managed devices, follow your organization's software installation policy.

### Claude installation

Claude functionality uses the official Anthropic runtime, installed separately by the user; Anthropic's terms apply. The runtime and Agent SDK are **not bundled in Engram's installer**. ChatGPT's Codex runtime remains bundled under Apache-2.0; see [Third-party notices](THIRD_PARTY_NOTICES.md).

1. Choose **Install Claude runtime** during onboarding or in **Settings → AI**.
2. Engram downloads the pinned official packages from the npm registry using the system's Chromium networking stack, verifies package integrity, and installs them in its user-data directory. It does not run package installation scripts or install globally.
3. Choose **Connect Claude** and finish Anthropic's official sign-in flow with your own account. Engram does not read, collect, or proxy your credentials.

If downloading fails, retry or use the **Official installation guide** link for network and platform troubleshooting, then retry installation in Engram. API billing is not silently substituted for subscription access. You can also continue without Claude and connect later.

### Capture timing

Direct captures and supported file imports enter the filing queue immediately. With the desk journal enabled, foreground application names and window titles are saved in five-minute segments and checked for filing every five minutes, with a five-minute settling window. Startup catches up on up to seven days of existing journal records. These are activity clues, not screenshots or proof that work was completed. Filing needs an available, connected AI; quota pauses leave captures queued on disk.

Windows downloads updates in the background and installs them on the next quit. Managed-device installation blocks require your administrator's approval. macOS packaging and signing hooks remain in the source for future support.

## Code signing policy

Releases are **not** code signed. Windows may warn on first launch; see Install above.

Signing is planned through the [SignPath Foundation](https://signpath.org/), which issues certificates to open-source projects at no cost. Nothing has been applied for or granted yet; this section will name the certificate once one exists. Until then, verify a download by its SHA-256 — GitHub prints one per asset on the release page.

Since March 2024 a certificate alone does not silence Windows: SmartScreen decides by publisher *reputation*, which accrues from download volume over time. So the first signed builds will still warn.

**Privacy:** AI requests send relevant context to the selected provider. Enabled background filing also makes AI requests. Runtime/model downloads, release update checks, explicitly configured sync, and browser tasks contact their respective services. Capture files and the vault remain local unless you configure a sharing or sync destination.

**Maintainer:** one person — [YunJae00](https://github.com/YunJae00), sole author and release signer-to-be.

## Build from source

Prerequisites: Node 22+, pnpm 9+.

```bash
pnpm install
pnpm dev            # run the desktop app in dev mode
pnpm run check      # typecheck + lint + unit tests + hygiene scans
pnpm run test:e2e   # Playwright end-to-end suite
pnpm run dist       # build the installer
```

## Architecture

```
packages/core     the engine: vault operations, librarian jobs, memory model,
                  retrieval, capture parsing — pure Node, no Electron imports,
                  fully unit-tested
apps/desktop      the Electron shell: windows, IPC, the brains' runtimes,
                  semantic indexer, capture watchers, the UI (React + canvas sky)
```

The core is the product; the desktop app is a shell around it. Anything the app can do, the core can do headless. [ARCHITECTURE.md](ARCHITECTURE.md) has the memory model in detail — the equations, the thresholds, and why each one is where it is.

## Language

The interface is English. The librarian is not: it writes each memory in the language you captured it in, so a Korean thought stays Korean and an English one stays English, in the same vault. The embedding model is multilingual, so search crosses languages too.

## Honest status

One author, one primary machine, roughly a year of daily use on a real vault. The memory-model constants (association floors, decay classes, the resurfacing band) were calibrated against that one vault; they are reasonable defaults, not tuned universals. Expect rough edges outside the Windows + Korean/English path, and please open an issue when you find one.

## License

[MIT](LICENSE)
