# Engram

[![CI](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)

**A second brain that runs entirely on your machine.**

Engram watches what you work on, files it into a plain-markdown vault, and organizes it the way human memory works — memories strengthen with use, fade without it, associate by meaning, and consolidate while you're away. All of it happens on-device: a local LLM writes the notes, local embeddings connect them, and nothing ever leaves your computer.

No cloud. No account. No subscription.

## How it works

**Capture.** Drop a thought into the composer, drop a file on the window, or just work — Engram can (with your consent, folder by folder) notice saved documents (`docx` / `xlsx` / `pptx` / `pdf` / `hwpx`), your browser trail (titles only, from the browser's local history), and transcripts of AI CLI sessions (Claude Code, Codex). Everything lands in an inbox as plain text.

**The librarian.** A background worker absorbs the inbox into structured markdown notes — titled, tagged with decay class and salience, linked to related memories, deduplicated, superseded when a newer note replaces an older claim. It settles its own questions; you are almost never asked anything. Sentence-writing is done by a local model (Gemma, Apache 2.0) running **in-process** via [`node-llama-cpp`](https://github.com/withcatai/node-llama-cpp) — no sidecar server, which also means it survives corporate endpoint protection that blocks unsigned executables.

**The memory model.** Judgment is embeddings, prose is the LLM, hygiene is rules:

- **Activation** — every note carries a retrieval strength computed with the ACT-R base-level equation (recency + frequency of actual use). It drives star brightness, list dimming, and retrieval ranking. Frequently-used memories stay vivid for months; untouched ones cool but are never deleted.
- **Association** — a similarity fabric (bge-m3 embeddings, incremental neighbor cache) links notes that live close in meaning-space, groups them into topics even before any explicit link exists, and draws faint threads between them in the sky.
- **Re-exposure warmth** — a new capture landing near an old note re-warms it, the way hearing a topic again refreshes your memory of it.
- **Hebbian co-recall** — memories retrieved together wire together; retrieval spreads along those synapses.
- **Consolidation** — during background sweeps, clusters held together only by meaning get a synthesized hub note, turning resemblance into structure.
- **Resurfacing** — memories with high storage strength but sinking retrieval strength appear as a quiet list in the Today sheet. Opening one is the reinforcement.

**The vault.** Everything is markdown files with frontmatter, in a folder you own. Sync it with git if you like. Derived state (embeddings, caches) lives in a separate directory and can always be rebuilt.

## Surfaces

- **Cosmos** — every memory a star; brightness is memory strength, constellations are topics, gold halos mark recent recall.
- **Brain** — topics as readable pages, warm topics first, with the librarian's synthesis on top.
- **List / Timeline** — the raw memories, filterable.
- **Today** — the measured day (hours per app), the morning brief, open loops, and fading memories.
- **Chat** — ask your memory; retrieval is hybrid (lexical + semantic + spreading activation) with instant source cards.
- **MCP server** — connect AI tools to your memory: context injection, search, capture, and graph traversal over the Model Context Protocol.

## What it reads, and what never leaves

Engram only sees what you let it see, and nothing is ever uploaded — there is no server to upload to.

| source | what is read | opt-in |
|---|---|---|
| the composer | what you type | always on |
| dropped files | the text of the file | per drop |
| document folders | the *changed lines* of documents you save there | per folder, off by default |
| browser history | page **titles and hosts** from the browser's own local history — never URLs, never content; login/auth pages are filtered out | off by default |
| AI CLI sessions | transcripts of Claude Code / Codex sessions on this machine | off by default |
| active window | app name and window title, for the "at the desk today" line | off by default |

Everything lands as markdown in a folder you choose. `private/` is never passed to any engine. Derived state (embeddings, caches) lives under `.engram/` and can be deleted at any time.

## Install

Grab the installer from [Releases](../../releases). On first run you pick a local model (curated Gemma builds, sized to your RAM — from an 8 GB-friendly 2B to a 26B MoE); it downloads once and everything runs offline from then on.

Windows is the tested platform. macOS builds are produced by CI and the code paths are in place, but they have had far less real use — bug reports welcome. Linux builds exist and are the least exercised of the three.

The installers are unsigned, so Windows SmartScreen and macOS Gatekeeper will warn on first launch.

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
apps/desktop      the Electron shell: windows, IPC, local LLM host, semantic
                  indexer, capture watchers, the UI (React + canvas sky)
```

The core is the product; the desktop app is a shell around it. Anything the app can do, the core can do headless. [ARCHITECTURE.md](ARCHITECTURE.md) has the memory model in detail — the equations, the thresholds, and why each one is where it is.

## Language

The interface is English. The librarian is not: it writes each memory in the language you captured it in, so a Korean thought stays Korean and an English one stays English, in the same vault. The embedding model is multilingual, so search crosses languages too.

## Honest status

One author, one primary machine, roughly a year of daily use on a real vault. The memory-model constants (association floors, decay classes, the resurfacing band) were calibrated against that one vault; they are reasonable defaults, not tuned universals. Expect rough edges outside the Windows + Korean/English path, and please open an issue when you find one.

## License

[MIT](LICENSE)
