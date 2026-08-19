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
| browser history | page **titles and hosts** from the browser's own local history — never URLs, never content; login/auth pages are filtered out | rides with the desk journal (below); off when it is off |
| AI CLI sessions | transcripts of Claude Code / Codex sessions on this machine | off by default |
| active window | app name and window title, for the "at the desk today" line — the desk journal | **on by default**, announced on first run, one switch in Settings/tray |

Everything lands as markdown in a folder you choose. `private/` is never passed to any engine. Derived state (embeddings, caches) lives under `.engram/` and can be deleted at any time.

## Install

Grab the installer from [Releases](../../releases). On first run you pick a local model (curated Gemma builds, sized to your RAM — from an 8 GB-friendly 2B to a 26B MoE); it downloads once and everything runs offline from then on.

Windows is the tested platform. macOS builds are produced by CI and the code paths are in place, but they have had far less real use — bug reports welcome. Linux target configuration exists but CI does not publish Linux artifacts yet.

Neither installer is signed by an identified developer, so both platforms stop the first launch. On Windows SmartScreen warns — **More info → Run anyway**; the Run anyway button does not exist until you click More info first. On macOS, open Engram once, let it be blocked, then go to **System Settings → Privacy & Security** and press **Open Anyway** next to the message about Engram. (Right-click → Open used to be the shortcut; recent macOS releases no longer accept it for un-notarized apps.)

Some managed Windows machines are set to *block* rather than warn, and then there is no Run anyway button at all. Check with:

```powershell
Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System' | Select ShellSmartScreenLevel
```

`Block` means an administrator set that policy and only they can change it. SmartScreen only inspects files carrying the mark the browser puts on a download, so removing that mark from a file you already trust lets it install — it changes one property of your own copy, not any policy:

```powershell
Unblock-File "$env:USERPROFILE\Downloads\Engram-Setup-<version>.exe"
```

macOS builds carry an ad-hoc signature. It identifies nobody, but it makes the bundle's seal match its contents, which is the difference between being *blocked* and being called **damaged** — and a build macOS calls damaged cannot be let through from the Finder at all. Builds before v0.2.6 have that broken seal; this repairs one in place:

```bash
xattr -cr /Applications/Engram.app && codesign --force --deep --sign - /Applications/Engram.app
```

A first launch with no questions asked, and real self-updates, both need a paid Apple Developer ID to sign and notarize with.

Updates follow from that. Windows updates itself in the background and installs on the next quit. macOS cannot: the swap is handed to Squirrel, which refuses any build whose code signature it cannot validate against the running app's, so an unsigned build downloads the update and then rejects it. There, Engram only *tells* you a version is out — Settings → Updates → Check now, and the button opens the download page.

## Code signing policy

Releases are **not** code signed. There is no certificate behind these binaries, and that is why both platforms stop the first launch — see Install above for what to click.

Signing is planned through the [SignPath Foundation](https://signpath.org/), which issues certificates to open-source projects at no cost. Nothing has been applied for or granted yet; this section will name the certificate once one exists. Until then, verify a download by its SHA-256 — GitHub prints one per asset on the release page.

Since March 2024 a certificate alone does not silence Windows: SmartScreen decides by publisher *reputation*, which accrues from download volume over time. So the first signed builds will still warn.

**Privacy:** this program will not transfer any information to other networked systems unless specifically requested by the user. The exception is explicit and listed above — model downloads from Hugging Face, and whatever an errand you start goes on to fetch.

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
