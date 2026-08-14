import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ClaudeChatSession } from "./chat-session.js";
import { errorEvent, probeCli, spawnLines } from "./spawn.js";
import {
  assertEngineCwd,
  ENGINE_BUDGETS,
  extractJson,
  type Engine,
  type EngineCwd,
  type EngineDetection,
  type EngineEvent,
  type EngineJobInput,
} from "./types.js";

export async function claudeLoggedIn(
  home: string = homedir(),
): Promise<boolean> {
  try {
    const file = join(home, ".claude", ".credentials.json");
    // key PRESENCE only — the token value is a secret and never leaves here
    const parsed = JSON.parse(await readFile(file, "utf8")) as Record<
      string,
      unknown
    >;
    const token = parsed["claudeAiOauth"];
    return (
      !!token && (typeof token !== "object" || Object.keys(token).length > 0)
    );
  } catch {
    // missing file, unreadable, or half-written → not logged in
    return false;
  }
}

// CSI colour codes and OSC (title/hyperlink) sequences, which arrive around
// the JSON when the CLI thinks it is talking to a terminal.
// prettier-ignore -- the disable comment must sit directly above the literal
// eslint-disable-next-line no-control-regex -- matching ESC sequences is the point
const ANSI_NOISE = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B\[[0-?]*[ -/]*[@-~]/g;

// The parse, split out so it is unit-testable without spawning anything.
// Returns null for "the CLI did not answer the question" — an old CLI, a usage
// dump, an empty stream. Null is NOT false: see Engine.verifyAuth.
export function parseAuthStatus(raw: string): boolean | null {
  const text = raw.replace(ANSI_NOISE, "");
  try {
    const value = extractJson(text);
    if (
      value &&
      typeof value === "object" &&
      typeof (value as Record<string, unknown>)["loggedIn"] === "boolean"
    ) {
      return (value as Record<string, unknown>)["loggedIn"] as boolean;
    }
  } catch {
    /* no balanced JSON in the output — try the looser read below */
  }
  // Looser fallback: the field alone, in case the JSON shares the stream with
  // log lines that break balance (observed shape stays `"loggedIn": <bool>`).
  const match = /"loggedIn"\s*:\s*(true|false)/.exec(text);
  return match ? match[1] === "true" : null;
}

// A hung `claude auth status` must not hold a boot or a health tick. The
// measured warm time is 1.2s; 15s is a cold-start allowance, not a budget.
const AUTH_STATUS_TIMEOUT_MS = 15_000;

export async function claudeAuthStatus(
  binary = "claude",
): Promise<boolean | null> {
  try {
    // No extra flags: `claude auth status` is what was measured to print JSON,
    // and passing an --output-format an older build does not know would turn a
    // working probe into a usage dump.
    // A question, not work: never demoted (see spawn.ts track) — a starved
    // auth check reads as 'could not ask' and freezes the health verdict.
    const stream = spawnLines(binary, ["auth", "status"], {
      cwd: homedir(),
      timeoutMs: AUTH_STATUS_TIMEOUT_MS,
      lowPriority: false,
    });
    let out = "";
    for (;;) {
      const { value, done } = await stream.next();
      if (done) break;
      out += `${value}\n`;
    }
    // Deliberately ignores the exit code: a logged-OUT CLI may well exit
    // non-zero while printing a perfectly good {"loggedIn":false}.
    return parseAuthStatus(out);
  } catch {
    // spawn failure, missing binary, timeout — we could not ask.
    return null;
  }
}

// Positive answers are cached briefly so detect() stays cheap where it is
// called often (the diagnostics screen re-detects every 4s, and window focus
// re-detects too). 60s bounds how long a login that died can still read as
// alive, which the 10-minute background re-verification then closes for good.
// A NEGATIVE is never cached: the whole point of the login terminal is that
// the very next poll after a successful login turns the light green.
const AUTH_CACHE_MS = 60_000;
let authCache: { binary: string; at: number } | null = null;

// Detections currently running, keyed by binary — see ClaudeAdapter.detect.
// Module-level because createEngine builds a NEW adapter for every caller, so
// per-instance state would coordinate nothing.
const detectInFlight = new Map<string, Promise<EngineDetection>>();
const detectCache = new Map<string, { at: number; result: EngineDetection }>();
const DETECT_CACHE_MS = 30_000;

// Tests and the "user just logged out" path need the caches gone immediately.
export function resetClaudeAuthCache(): void {
  authCache = null;
  detectCache.clear();
}

// The whole policy, as one pure function so it is testable without spawning:
//   no token file            → logged out (and no subprocess was ever needed)
//   the CLI answered         → the CLI wins, always (it sees expiry + refresh)
//   the CLI could NOT answer → keep the file check's answer
// That last line is the one that matters: an older CLI without `auth status`,
// or a spawn that failed, must never be read as "logged out" — that would
// silently disable the librarian on a perfectly working machine.
export function resolveLoggedIn(
  hasTokenFile: boolean,
  cliVerdict: boolean | null,
): boolean {
  if (!hasTokenFile) return false;
  return cliVerdict ?? true;
}

// Claude Code headless adapter: `claude -p <prompt> --output-format stream-json`.
// stream-json emits one JSON object per line:
//   {"type":"assistant","message":{"content":[{"type":"text","text":"…"}]}}
//   {"type":"result","subtype":"success","result":"full text"}
// With --include-partial-messages the CLI additionally streams the raw API
// events as they arrive, wrapped one-per-line:
//   {"type":"stream_event","event":{"type":"content_block_delta",
//     "delta":{"type":"text_delta","text":"…"}}}
// We consume those text deltas for smooth streaming and skip the trailing
// `assistant` summary when deltas were seen, so the answer tokenises once.
export class ClaudeAdapter implements Engine {
  readonly id = "claude" as const;
  // claude -p reads images via its Read tool — used by the hybrid ingest.
  readonly vision = true;

  constructor(
    private timeoutMs = 300_000,
    private binary = "claude",
  ) {}

  // Concurrent callers share one probe. Detection spawns `claude --version`
  // and `claude auth status` — 3.6s of subprocess on an idle machine — and
  // EIGHT paths ask for it, none of which knew about the others: boot,
  // auto-install's presence check, the ten-minute auth watch, window focus, the
  // Diagnostics 4s poll, power resume, install-ready, and every failed chat
  // call. Boot alone fires two within milliseconds. A user with Diagnostics
  // open who alt-tabs into a laptop waking from sleep could have four probes
  // running at once, eight processes deep — and the machines where that hurts
  // are exactly the ones already slow enough for the 10s probe to time out,
  // i.e. the ones reporting that Claude keeps disconnecting. Piling on more
  // concurrent spawns is the worst available response to a slow machine.
  //
  // Only the IN-FLIGHT call is shared, never a finished one: the moment a probe
  // resolves the next caller gets a fresh answer, so nothing here can make the
  // app report a stale login. Keyed by binary — a managed copy and a PATH copy
  // are different questions.
  detect(): Promise<EngineDetection> {
    const shared = detectInFlight.get(this.binary);
    if (shared) return shared;
    const cached = detectCache.get(this.binary);
    if (cached && Date.now() - cached.at < DETECT_CACHE_MS)
      return Promise.resolve(cached.result);
    const run = this.detectNow()
      .then((result) => {
        // FULLY-GREEN results only, like the auth cache's positives rule: a
        // "not installed" or "logged out" answer must never linger — the
        // Connect/login screens' whole job is turning green on the very next
        // poll after the user fixes it. Green is also the steady state where
        // the 4s/15s polls were burning subprocesses for an answer that
        // cannot change that fast.
        if (result.conclusive && result.installed && result.loggedIn) {
          detectCache.set(this.binary, { at: Date.now(), result });
        }
        return result;
      })
      .finally(() => detectInFlight.delete(this.binary));
    detectInFlight.set(this.binary, run);
    return run;
  }

  private async detectNow(): Promise<EngineDetection> {
    const installed = await probeCli(this.binary);
    // null = the probe timed out. Say so instead of reporting an absence we
    // never established — the caller keeps a previously working engine.
    if (installed === null)
      return { installed: false, loggedIn: false, conclusive: false };
    if (!installed)
      return { installed: false, loggedIn: false, conclusive: true };
    return { installed, loggedIn: await this.loggedInNow(), conclusive: true };
  }

  // Authoritative and UNCACHED — the periodic health check calls this, and a
  // cached answer would defeat its entire purpose.
  async verifyAuth(): Promise<boolean | null> {
    // Same cheap negative as below: no token file at all is a definite no, and
    // it costs no subprocess.
    if (!(await claudeLoggedIn())) return false;
    const status = await claudeAuthStatus(this.binary);
    if (status === true) authCache = { binary: this.binary, at: Date.now() };
    else if (status === false) authCache = null;
    return status;
  }

  // Cheapest first: the file check is a free NEGATIVE pre-filter (no token file
  // at all → no subprocess), a fresh positive skips the spawn, and only then do
  // we pay ~1.2s to ask the CLI. resolveLoggedIn() above holds the policy.
  private async loggedInNow(): Promise<boolean> {
    const hasTokenFile = await claudeLoggedIn();
    if (!hasTokenFile) return false;
    if (
      authCache &&
      authCache.binary === this.binary &&
      Date.now() - authCache.at < AUTH_CACHE_MS
    )
      return true;
    const status = await claudeAuthStatus(this.binary);
    if (status === true) authCache = { binary: this.binary, at: Date.now() };
    else if (status === false) authCache = null;
    return resolveLoggedIn(hasTokenFile, status);
  }

  // The warm chat lane (chat-session.ts): one process, many turns. Chat has
  // tools fully off, so the session runs bare — no MCP, model default tier
  // (a human asking questions rides the smart model, same as run()'s chat).
  openChat(opts: {
    workdir: EngineCwd;
    turnTimeoutMs?: number;
  }): ClaudeChatSession {
    assertEngineCwd(opts.workdir);
    const session = new ClaudeChatSession(
      this.binary,
      [
        "-p",
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--disallowedTools",
        "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,NotebookEdit,Task",
        "--strict-mcp-config",
      ],
      {
        workdir: opts.workdir,
        turnTimeoutMs: opts.turnTimeoutMs ?? ENGINE_BUDGETS.chat,
      },
    );
    session.start();
    return session;
  }

  async *run(job: EngineJobInput): AsyncIterable<EngineEvent> {
    assertEngineCwd(job.workdir);
    // Windows spawns the .cmd shim through a shell, so the prompt must never
    // appear in argv — pipe it via stdin there (claude -p reads stdin).
    const viaStdin = process.platform === "win32";
    // --include-partial-messages is flag-only, so it stays argv-safe under the
    // Windows shell path; the prompt still travels via stdin, untouched. If an
    // older CLI ignores the flag, no stream_event lines appear and we fall back
    // to the `assistant` summary below — the parser tolerates either shape.
    // --disallowedTools is likewise flag-only (an OPTION, never the prompt), so
    // it is appended to both paths without ever touching the stdin/argv rule.
    const disallow = job.disallowTools
      ? [
          "--disallowedTools",
          "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,NotebookEdit,Task",
        ]
      : job.readOnly
        ? [
            "--disallowedTools",
            "Bash,Edit,Write,WebFetch,WebSearch,NotebookEdit,Task",
          ]
        : [];
    const noMcp = job.disallowTools ? ["--strict-mcp-config"] : [];
    // 'fast' → the adapter's fast tier. The value is config, not policy:
    // ENGRAM_FAST_MODEL_CLAUDE overrides it (set '' to never pass --model);
    // 'haiku' is only the fallback — the CLI's own stable tier alias, which the
    // vendor maintains across model generations (not a dated model id).
    const fastModel = process.env["ENGRAM_FAST_MODEL_CLAUDE"] ?? "haiku";
    // 'smart' → the judgment tier. Librarian judgment jobs used to ride the
    // subscription's DEFAULT model (often the priciest one) — sonnet is
    // plenty for supersede/conflict/synthesis calls at a fraction of the
    // cost. Chat alone still runs the user's default model (no hint).
    const smartModel = process.env["ENGRAM_SMART_MODEL_CLAUDE"] ?? "sonnet";
    const tier =
      job.modelHint === "fast"
        ? fastModel
        : job.modelHint === "smart"
          ? smartModel
          : "";
    const model = tier ? ["--model", tier] : [];
    const args = viaStdin
      ? [
          "-p",
          "--output-format",
          "stream-json",
          "--include-partial-messages",
          "--verbose",
          ...disallow,
          ...noMcp,
          ...model,
        ]
      : [
          "-p",
          job.prompt,
          "--output-format",
          "stream-json",
          "--include-partial-messages",
          "--verbose",
          ...disallow,
          ...noMcp,
          ...model,
        ];
    const stream = spawnLines(this.binary, args, {
      cwd: job.workdir,
      // Per-call budget over the adapter default — the caller knows whether
      // it is a 45s speech bubble or a 300s librarian job (ENGINE_BUDGETS).
      timeoutMs: job.timeoutMs ?? this.timeoutMs,
      idleTimeoutMs: job.idleTimeoutMs,
      signal: job.signal,
      ...(viaStdin ? { stdin: job.prompt } : {}),
    });
    // Every exit path must reap the child, including the ones that leave via a
    // THROW at a yield — which is exactly what happens on a classified error
    // (collectResult throws at the error event). Without this the generator was
    // finalised at that yield, spawnLines' own finally never ran, and each
    // quota/auth failure orphaned a live claude process plus a 300s timer.
    try {
      yield* parseStreamJson(stream);
    } finally {
      await stream.return({ code: 0, stderr: "" }).catch(() => undefined);
    }
  }
}

// The stream-json line parser. A free generator, not a method, so `run` can
// wrap the whole of it in one try/finally without re-indenting the parser.
async function* parseStreamJson(
  stream: ReturnType<typeof spawnLines>,
): AsyncIterable<EngineEvent> {
  let sawResult = false;
  let streamedDelta = false;
  for (;;) {
    const { value, done } = await stream.next();
    if (done) {
      // A cancel is the caller's own decision — end silently, no error event
      // (an error here painted "engine failed" banners over deliberate stops).
      if (value.stderr.includes("[engram] canceled")) return;
      // The exit code rides along so classification can call a non-zero exit
      // with unreadable stderr a crash rather than an "unknown".
      if (value.code !== 0 && !sawResult) {
        yield errorEvent(
          `claude exited ${value.code}: ${value.stderr.slice(0, 500)}`,
          value.code,
        );
      }
      return;
    }
    const line = value.trim();
    if (!line.startsWith("{")) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed["type"] === "stream_event") {
      // Incremental text deltas from --include-partial-messages. Only
      // content_block_delta/text_delta carries answer text; message_start,
      // content_block_start, thinking deltas, message_stop, … are ignored.
      const event = parsed["event"] as
        { type?: string; delta?: { type?: string; text?: string } } | undefined;
      if (
        event?.type === "content_block_delta" &&
        event.delta?.type === "text_delta" &&
        event.delta.text
      ) {
        streamedDelta = true;
        yield { type: "token", text: event.delta.text };
      }
    } else if (parsed["type"] === "assistant") {
      // The full assembled message. When partial deltas already streamed it,
      // this is a duplicate — emit it as tokens only in the fallback path
      // (flag unsupported, no deltas seen) so text is tokenised exactly once.
      if (!streamedDelta) {
        const message = parsed["message"] as
          { content?: { type: string; text?: string }[] } | undefined;
        for (const block of message?.content ?? []) {
          if (block.type === "text" && block.text)
            yield { type: "token", text: block.text };
        }
      }
    } else if (parsed["type"] === "result") {
      sawResult = true;
      if (parsed["is_error"]) {
        const message = String(parsed["result"] ?? "claude error result");
        const retryAfterMs = parseRetryAfterMs(message);
        const base = errorEvent(message);
        if (base.type === "error" && retryAfterMs !== undefined)
          yield { ...base, retryAfterMs };
        else yield base;
      } else yield { type: "result", text: String(parsed["result"] ?? "") };
      return;
    }
    // Any other line type is ignored silently.
  }
}

// Best-effort extraction of "when does the limit lift" from a quota message.
// The CLI's wording shifts between versions, so this is a pattern ladder that
// falls through to undefined — the backoff gate then uses its own schedule.
// Pure and exported for direct unit tests.
export function parseRetryAfterMs(
  text: string,
  now: number = Date.now(),
): number | undefined {
  // "retry after 3600 seconds" / "retry-after: 120"
  const seconds = /retry[- ]?after[:\s]+(\d+)/i.exec(text)?.[1];
  if (seconds) return Number(seconds) * 1000;
  // "resets at 1753900000" — a unix epoch in seconds, in the future
  const epoch = /resets? at\D{0,10}(\d{10})\b/i.exec(text)?.[1];
  if (epoch) {
    const ms = Number(epoch) * 1000 - now;
    if (ms > 0) return ms;
  }
  return undefined;
}
