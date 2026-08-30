export * from './schema.js'
export * from './binary.js'
export { GitLayer } from './git.js'
export * from './vault.js'
export * from './notes.js'
export * from './store.js'
export * from './freshness.js'
export * from './loops.js'
export * from './context-block.js'
export * from './sessions.js'
export * from './jobs/session-harvest.js'
export * from './jobs/resolve.js'
export * from './jobs/closure.js'
export * from './chronology.js'
export * from './lineage.js'
export * from './search.js'
export * from './trace.js'
export * from './aliases.js'
export * from './activation.js'
export * from './misses.js'
export * from './vectors.js'
export * from './neighbors.js'
export * from './retrieval.js'
export { AGENTS_MD_V1 } from './agents-template.js'
export * from './cards.js'
export * from './engine/types.js'
// The index is the app-facing surface, deliberately narrower than the modules:
// tests and core internals import their module directly, so what stands here
// is exactly what the desktop, the CLI and the MCP server actually consume.
export { killAllEngineChildrenSync, setSpawnObserver } from './engine/spawn.js'
export { createPidLedger, sweepStaleEnginePids } from './engine/reaper.js'
export { engineBackoff } from './engine/backoff.js'
export * from './notifications.js'
export * from './verdicts.js'
export * from './receipts.js'
export * from './standup.js'
export * from './skills.js'
export * from './gardener.js'
export { MockEngine } from './engine/mock.js'
export {
  createEngine,
  detectAvailableEngines,
  detectEngineStates,
  setLocalTransport,
  type EngineBinaries,
  ENGINE_ORDER,
  keepsEngine,
  setCloudEngineFactory,
  type CloudEngineId,
} from './engine/registry.js'
export { LocalAdapter, type LocalTransport } from './engine/local.js'
export { spawnServerChild } from './engine/spawn.js'
export * from './jobs/graph.js'
export * from './jobs/subject.js'
export * from './jobs/prompts.js'
export * from './jobs/runner.js'
export * from './jobs/librarian.js'
export * from './jobs/sweep.js'
export { runCli, type CliIO } from './cli/main.js'
export { safeInboxName, startMcpServer, type McpOptions } from './mcp.js'
export * from './capture.js'
export * from './errand.js'
export * from './press-guard.js'
export { pageReport, linkReport, partsWith, PAGE_TEXT_CAP, type ReadablePage } from './page-report.js'
export { pageTools, type PageToolDeps } from './comet-page-tools.js'
export * from './parsers.js'
export * from './clipping.js'
export * from './ingest.js'
export * from './pack.js'
export * from './sync.js'
export * from './conflict.js'
export * from './import.js'
export { BundledBinaryProvider } from './bundled-binary.js'
export * from './audio.js'
export * from './capture/doc-extract.js'
export { addBotTask, appendBotTurn, createBot, deleteBot, dismissBotSuggestion, loadBots, loadDismissedSuggestions, markBotTaskRun, readBotTranscript, recommendBots, removeBotTask, renameBot, titleFromMessage, UNTITLED_BOT_NAME, declineStanding, type Bot, type BotSuggestion, type BotTask, type BotTurn } from './bots.js'
export { appendErrandRecord, readErrandJournal, type ErrandRecord } from './errand-journal.js'
export { addRoutine, clearRoutinePendingWrite, fillSlots, listRoutines, markRoutineRun, removeRoutine, routineBlock, routineSlots, routineStepLabel, routineWrites, runRoutine, validateRoutineSteps, type Routine, type RoutineBlock, type RoutineDriver, type RoutineReading, type RoutineRunOptions, type RoutineRunResult, type RoutineStep, type RoutineStepResult, type RoutineTarget } from './routine.js'
export { buildRoutineFromTeach, type TeachEvent } from './teach.js'
export { detectLoop, parsePendingCall, runAgentLoop, type AgentLoopDeps, type AgentLoopOptions, type AgentLoopResult, type AgentLoopStep, type AgentTool } from './agent-loop.js'
export { runComet, runToolSession, SESSION_TURN_MS } from './agent-session.js'
export { cometTools, type CometToolDeps } from './comet-tools.js'
export { choiceQuestion, cleanOptions, formatAsk, parseAsk, type Ask } from './ask.js'
export { fingerprintOf, hostOf, parseRule, ruleCovers, ruleFor, type ApprovalRule, type GatedAction } from './approval.js'
export { dueNow, guessSchedule, isSchedule, type Schedule } from './schedule.js'
export { askKey, repeatedAsk, sameAsk, type PastAsk, type RepeatVerdict } from './repeat.js'
export {
  factScore,
  forgetBotMemory,
  forgetFact,
  loadBotMemory,
  memorableTurn,
  parseFactLines,
  recordFacts,
  REMEMBER_TOKENS,
  rememberPrompt,
  renderMemory,
  selectForPrompt,
  type BotFact,
  type BotMemoryFile,
} from './bot-memory.js'
export { deriveSearchTemplate, rankLinks, searchUrlFor } from './search-template.js'
export { carriesSecret, secretsIn, withoutSecrets } from './secrets.js'
export { fitPrompt } from './prompt-budget.js'
export { parseRetryAfterMs } from './engine/classify.js'
export type { ToolSessionCall, ToolSessionJob, ToolSessionResult } from './engine/types.js'
