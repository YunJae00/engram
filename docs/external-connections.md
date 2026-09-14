# External connections

Engram can provide tools to a local MCP client while the desktop app is open. The client supplies the AI model; Engram supplies its memory, browser, files, supported Office operations, and saved routines. This is separate from choosing a model inside Engram.

## Connect

1. Open a workspace in Engram.
2. Open **Settings → External connections** and enable local connections for the current app session.
3. Choose **Connect** for Claude Code, Codex, or Claude Desktop, then reload the client’s MCP connection. Other local stdio-MCP clients can use **Copy MCP configuration**.
4. Ask the client to use Engram for a specific task. It should call `engram_begin` with that goal first.

Connections are off after restarting Engram until enabled again. Connecting does not sign in to an AI provider or transfer a subscription. Browser sign-ins remain in the browser profile used by Engram. This local connection is not a remote connector for a hosted chat website.

## Approval and data

- Starting a task creates a visible conversation in Engram.
- Each operation asks for approval, including reading data that will be returned to the client. Declining leaves the operation unexecuted.
- Returned notes, page content, files, and images can be sent to the client’s AI provider. Local storage does not mean that no data leaves the computer.
- Existing file-access and browser-submit safeguards still apply. Office tools additionally require **Computer use** to be enabled.
- **Stop sessions** cancels active requests and disconnects clients. Disabling connections does the same. An operation already delivered to an application might have taken effect; inspect it before retrying.

These controls govern only operations sent through this connection. They cannot prevent a client from using its own browser, shell, or other tools.

## Completion and routines

`engram_finish` records a result and checks Office readback coverage and supported arithmetic. It does not establish that the answer meets every business requirement or that a document looks correct. The client must inspect requested results and identify remaining uncertainty.

`engram_routine` returns a saved task’s goal, URLs, and method. It does not execute the task or return an old result as a fresh one. After checking a completed task, `engram_keep` asks the person to confirm success before saving a reusable routine.

## Existing configurations

No client configuration is changed merely by launching Engram. Explicit connection actions preserve unrelated settings and back up configurations that they replace. Invalid configuration files are not overwritten.

Older `--vault` or `--registry` memory-only configurations remain standalone and do not use the new app approval boundary. Reconnect them through Settings to use the bridge. Disabling the bridge does not disable an independently configured legacy memory server.

The local transport uses a random named pipe or Unix socket and a per-launch secret. Request state and operation names are recorded in `external/audit.jsonl` under Engram’s application data directory; argument contents and response bodies are not included in that log.
