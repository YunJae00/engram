# Architecture

Two packages. `packages/core` is the product — vault operations, the librarian, the memory model, retrieval — as pure Node with no Electron imports and full unit coverage. `apps/desktop` is a shell around it: windows, IPC, the local model host, the embedding indexer, the capture watchers, and the UI.

Anything the app can do, core can do headless. That is the constraint that keeps the memory model honest.

## The vault

```
workspace/
  notes/        one markdown file per memory, frontmatter is the schema
  inbox/        raw captures waiting to be absorbed
  sources/      the originals of absorbed captures
  _views/       briefs, digests, cards, job logs
  .engram/      DERIVED: embeddings, neighbor cache, journals, receipts
  AGENTS.md     the librarian's rulebook, synced from core, user-editable
private/        never passed to any engine, ever
```

Everything under `.engram/` is rebuildable. Delete it and the app reconstructs it from the markdown.

## The librarian

A sweep runs a queue of jobs (`packages/core/src/jobs/`). Each job is a `JobSpec`: a prompt assembled by quoting the relevant sections of AGENTS.md, plus an `apply()` that lands the result through core operations. Nothing an engine returns is trusted directly — ids are checked against real notes, bodies are shape-checked, and anything unsure becomes a proposal card rather than an edit.

| job | what it does |
|---|---|
| J1 | absorb an inbox capture into a note |
| J2 | link a new note to related ones, with a reason per link |
| J3 | raise a conflict card when two notes genuinely disagree |
| J4 | raise a supersede card when an update replaces an older claim |
| J5 | raise a stale card when a note's freshness window passed |
| J6 | infer `happened_at` from the body |
| J7 | propose merges for near-duplicates |
| J8 | write the morning brief |
| J9 | synthesize a hub note for each topic cluster |
| J10 | write the weekly digest |
| J11 | harvest notes from a finished AI CLI session |
| J12 | settle the librarian's own questions so the user is rarely asked |
| J13 | close open loops that a session conclusion answered |

The runner (`jobs/runner.ts`) journals every job by input key, so a sweep that changes nothing costs nothing — that idempotency is enforced by a test.

## The memory model

Each note carries, in frontmatter: `created`, `last_recalled`, `recall_count`, `warmth`, `salience`, `recall_links`, `decay`. From those, `packages/core/src/activation.ts` computes everything.

**Retrieval strength** (`noteActivation`) is the ACT-R base-level equation with Petrov's k=1 hybrid — the most recent use kept exact, earlier uses compressed into a tail term:

```
B = ln( t₁^-d + (n-1)·(L^(1-d) − t₁^(1-d)) / ((1-d)·(L − t₁)) ) + β_decay
activation = sigmoid((B − τ) / s)
```

`d` comes from the decay class (evergreen 0.25 → ephemeral 0.9), `L` is the note's age in days, `t₁` the age of the last recall, `n` the number of uses. Re-exposure warmth adds fractional uses. The result is 0..1 and drives star brightness, list dimming, and retrieval ranking. It is recomputed on read, never stored.

**Storage strength** is the other half of Bjork's two-strength model: a monotone function of accumulated uses, link degree and salience that never decreases. High storage with low retrieval is exactly the resurfacing queue (`fadingMemories`) — memories worth re-showing, because those relearn cheapest.

**Association** has three layers. Written links (`derived_from`) come from J2's judgement. Hebbian links (`recall_links`) thicken when memories are retrieved together and decay by a read-time half-life. The similarity fabric (`neighbors.ts`) is an incrementally maintained top-k cosine neighbor cache; pairs above the link-grade floor act as real edges in topic grouping and consolidation.

**Spreading activation** (`spreadActivation`) walks those edges from search hits, bounded to two hops, boosted by salience and recent recall. This is why a query can surface the note two links away that shares no keywords.

**Consolidation** happens during sweeps: clusters held together only by meaning earn a J9 hub note, which writes the resemblance down as real `derived_from` structure.

## Retrieval path

A question fuses lexical search (minisearch with CJK bigrams) and semantic search (bge-m3 cosine) by reciprocal rank, reranks the shortlist by activation, then spreads over the link fabric to pull in neighbors. Prospective memories with a matching trigger keyword self-surface regardless of overlap. No model call anywhere in that path.

## The engines

Two brains, each the vendor's own runtime bundled with the app and signed in to with the person's own account. Nothing switches between them behind their back: the one they chose answers, and one that is not signed in says so rather than handing the work to the other.

The embedding model is the one model that runs here. It is downloaded through Chromium's `net.fetch`, because TLS-inspecting proxies break Node's fetch, and it loads only when there is room for it.

## Where things live

```
packages/core/src/
  notes.ts, schema.ts      the vault and its frontmatter contract
  activation.ts            retrieval strength, spreading, resurfacing
  neighbors.ts, vectors.ts the similarity fabric and the embedding index
  jobs/                    the librarian
  mcp.ts                   the MCP server surface
  engine/                  engine adapters, spawn discipline, backoff

apps/desktop/src/
  main/                    IPC, engine runtimes, semantic indexer, capture watchers
  renderer/                React UI; the sky is canvas (components/sky)
  shared/types.ts          the only vocabulary crossing the IPC boundary
```
