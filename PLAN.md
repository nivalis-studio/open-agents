Summary: Migrate `packages/agent` from a singleton `ToolLoopAgent` to a `DurableAgent` factory driven by serializable runtime options, then move the web chat path to workflow-backed execution and stream recovery. Keep existing tool contracts and UI behavior stable by exporting a shared toolset, reconnecting sandboxes lazily from `sandboxId`, and replacing Redis resumable streams with workflow run resumption.

Context:
- `packages/agent/open-harness-agent.ts` currently exports a singleton `new ToolLoopAgent(...)` and injects a live `sandbox` and live `LanguageModel` objects into `experimental_context`.
- Core tools depend on `packages/agent/tools/utils.ts`, which assumes `experimental_context.sandbox` is already a connected `Sandbox`.
- Subagents in `packages/agent/subagents/explorer.ts` and `packages/agent/subagents/executor.ts` are also `ToolLoopAgent` singletons and inherit the same live-context assumptions.
- Web chat currently executes the agent directly in `apps/web/app/api/chat/route.ts` and persists reconnect state via `apps/web/lib/resumable-stream-context.ts` and `apps/web/app/api/chat/[chatId]/stream/route.ts`.
- The web client reconnect logic lives in `apps/web/app/sessions/[sessionId]/chats/[chatId]/session-chat-context.tsx` and currently wraps `DefaultChatTransport` with `apps/web/lib/abortable-chat-transport.ts`.
- `apps/web/app/types.ts` and `apps/cli/tui/types.ts` derive UI message/tool types from the runtime agent instance (`typeof webAgent` / `typeof tuiAgent`), which tightly couples typing to the current `ToolLoopAgent` export shape.
- Workflow support is already installed and configured in the web app (`workflow`, `workflow/api`, `workflow/next`, existing lifecycle workflow). A compatible workflow AI package version for the current `workflow@4.1.0-beta.52` stack is `@workflow/ai@4.0.1-beta.52`.
- The plan assumes the web workflow path is the primary migration target. CLI should keep compiling during the refactor, but it does not need to adopt workflow transport in the same pass.

Approach: Introduce a serializable agent runtime context and a `DurableAgent` factory in `packages/agent`, export the shared Open Harness toolset separately from the runtime agent instance, and reconnect sandboxes lazily from `sandboxId` inside tool execution. On the web side, move chat execution into a workflow that owns the durable agent lifecycle and stream, return `x-workflow-run-id` from the POST route, reconnect through `workflow/api.getRun(...).getReadable({ startIndex })`, and replace the current resumable-stream Redis transport with `WorkflowChatTransport`.

Changes:
- `packages/agent/open-harness-agent.ts`
  - Replace the singleton `ToolLoopAgent` export with a factory such as `createOpenHarnessDurableAgent(options)`.
  - Port current runtime behavior into DurableAgent configuration:
    - system prompt assembly via `buildSystemPrompt(...)`
    - compaction tuning and aggressive context compaction via `prepareStep`
    - OpenAI reasoning cleanup via `preparePromptForOpenAIReasoning(...)`
    - step limit migration from `stepCountIs(200)` to DurableAgent `maxSteps: 200`
  - Change call options from live objects to serializable descriptors:
    - `sandboxId` instead of `sandbox`
    - model descriptors / model IDs plus provider overrides instead of `LanguageModel` objects
    - serializable prompt/environment metadata (`workingDirectory`, `currentBranch`, `environmentDetails`, `customInstructions`, `skills`, compaction context)

- `packages/agent/toolset.ts` (new)
  - Move the shared Open Harness tool registry out of `open-harness-agent.ts` into a standalone export, e.g. `openHarnessTools`.
  - Reuse this export in the DurableAgent factory and in app consumers that currently need `webAgent.tools` / `tuiAgent.tools` for `convertToModelMessages(...)`.
  - This file becomes the stable typing source for UI message/tool derivation after removing agent-instance coupling.

- `packages/agent/types.ts`
  - Add serializable runtime types for the durable context, including:
    - sandbox metadata (`sandboxId`, `workingDirectory`, `currentBranch`, `environmentDetails`)
    - approval config
    - skill metadata
    - compaction context
    - model descriptors needed to rebuild models inside the workflow/runtime layer
  - Keep `ApprovalConfig`, `ApprovalRule`, `TodoItem`, and related schemas unchanged where possible.

- `packages/agent/models.ts`
  - Add a serializable model descriptor shape that can reconstruct the main model and subagent model without persisting live `LanguageModel` instances.
  - Reuse the existing gateway/provider-options logic so DurableAgent creation still honors current defaults and model variant overrides.

- `packages/agent/tools/utils.ts`
  - Split context helpers into two responsibilities:
    - approval/path metadata access from serializable runtime context
    - lazy sandbox connection from `sandboxId`
  - Replace the current synchronous `getSandbox(...)` assumption with an async reconnect path that connects before file or shell operations run.
  - Update `getApprovalContext(...)` to rely on serialized `workingDirectory` instead of a live sandbox object.
  - Preserve current error messaging and approval defaults when context is missing or malformed.
  - Add a process-local sandbox cache keyed by `sandboxId` only as an optimization; correctness must depend on reconnecting from serializable state.

- `packages/agent/tools/read.ts`
  - Reconnect the sandbox from `sandboxId` at the start of `execute(...)`, before calling `stat`/`readFile`.
  - Keep the current read contract and path validation behavior unchanged.

- `packages/agent/tools/write.ts`
  - Reconnect from `sandboxId` at the start of `execute(...)` before `mkdir`/`writeFile`.
  - Keep exact output contract (`path`, `bytesWritten`) unchanged.

- `packages/agent/tools/grep.ts`
  - Reconnect from `sandboxId` at the start of `execute(...)` before shell execution.
  - Continue using `workingDirectory` from serialized context for path normalization and approval.

- `packages/agent/tools/glob.ts`
  - Reconnect from `sandboxId` at the start of `execute(...)` before filesystem access.
  - Keep current approval/path semantics unchanged.

- `packages/agent/tools/bash.ts`
  - Reconnect from `sandboxId` before executing shell commands.
  - Preserve current approval behavior, command safety checks, and detached-command rules.

- `packages/agent/tools/task.ts`
  - Update parent-context access to use the serializable durable context.
  - Replace `ToolLoopAgent` subagent execution with DurableAgent-based explorer/executor factories.
  - Preserve the current task UI contract (`pending`, `toolCallCount`, `startedAt`, `modelId`, `usage`, `final`) by translating streamed UI/tool chunks from the subagent run back into the existing `TaskToolOutput` shape.
  - Ensure delegated subagents receive only serializable data and reconnect their own sandbox from `sandboxId`.

- `packages/agent/subagents/explorer.ts`
  - Replace the `ToolLoopAgent` singleton with a DurableAgent factory.
  - Preserve the existing explorer prompt, tool restrictions, and `maxSteps: 100` equivalent.

- `packages/agent/subagents/executor.ts`
  - Replace the `ToolLoopAgent` singleton with a DurableAgent factory.
  - Preserve the existing executor prompt, validation instructions, and `maxSteps: 100` equivalent.

- `packages/agent/index.ts`
  - Export the new DurableAgent factory and the shared `openHarnessTools` export.
  - Stop making consumers depend on a singleton runtime instance for typing or tool access.
  - Keep compatibility exports where practical, but avoid re-exporting a `ToolLoopAgent`-specific API surface.

- `packages/agent/package.json`
  - Add `@workflow/ai@4.0.1-beta.52`.
  - Keep the rest of the package dependency surface unchanged unless the refactor proves additional workflow/runtime helpers are required.

- `apps/web/app/config.ts`
  - Replace the current `webAgent = openHarnessAgent` singleton export with the new factory/config entry point or, if no runtime singleton remains, reduce this file to exported shared configuration defaults used by the workflow.
  - Avoid exporting a runtime object that implies direct request-time execution in the route.

- `apps/web/app/types.ts`
  - Stop deriving message/tool types from `typeof webAgent`.
  - Derive types from the shared exported toolset instead, e.g. `UIMessage<Metadata, never, InferUITools<typeof openHarnessTools>>`.
  - Keep `WebAgentMessageMetadata` stable so current token-usage UI continues to work.

- `apps/cli/tui/types.ts`
  - Stop deriving message/tool types from `typeof tuiAgent`.
  - Derive CLI UI message/tool types from the shared exported toolset so the agent package refactor does not break CLI compilation.

- `apps/cli/tui/transport.ts`
  - Replace `agent.tools` usage in `convertToModelMessages(...)` with the shared exported toolset.
  - If the CLI still needs a direct local agent path after the refactor, adapt it to the new factory without adopting workflow transport in this pass.

- `apps/cli/tui/config.ts`
  - Update any direct `openHarnessAgent` singleton imports to use the new durable factory or compatibility wrapper.
  - Keep the existing interactive approval factory behavior intact.

- `apps/web/app/workflows/chat.ts` (new)
  - Create the main durable chat workflow.
  - Workflow responsibilities:
    1. rebuild model instances from serializable descriptors
    2. do sandbox preflight work in steps (connect, apply repo auth if needed, discover skills, refresh environment metadata)
    3. create the DurableAgent via `createOpenHarnessDurableAgent(...)`
    4. stream to `getWritable<UIMessageChunk>()`
    5. enable `collectUIMessages: true` so the workflow can persist final/polished UI messages without rereading the stream
    6. persist assistant message, usage, and sandbox state on completion
  - Keep workflow logic step-based wherever non-deterministic side effects occur.

- `apps/web/app/api/chat/route.ts`
  - Remove direct `webAgent.stream(...)` execution and all `resumableStreamContext.createNewResumableStream(...)` logic.
  - Keep current auth, chat/session ownership checks, and optimistic user-message persistence.
  - Start the new chat workflow via `workflow/api.start(...)`.
  - Return the workflow stream with `createUIMessageStreamResponse(...)` and set `x-workflow-run-id` on the response.
  - Reuse the current active-stream ownership token pattern by storing a composite `"{startedAt}:{runId}"` in `chats.activeStreamId`; keep the existing CAS/newer-request-wins behavior.
  - Preserve current side effects on natural finish:
    - assistant message persistence
    - usage recording
    - sandbox state persistence
    - diff refresh / auto-commit hooks
  - Preserve or explicitly replace current message metadata behavior (`lastStepUsage`, `totalMessageUsage`) so downstream UI and context compaction do not regress.

- `apps/web/app/api/chat/[chatId]/stream/route.ts`
  - Replace Redis resumable-stream resume logic with workflow resume logic.
  - Continue authenticating by `chatId` ownership.
  - Read the active run ID from `chat.activeStreamId`.
  - Parse the client `startIndex` query parameter and call `getRun(runId).getReadable({ startIndex })`.
  - Return 204 when there is no active run or the chat has no in-flight stream.
  - Clear stale `activeStreamId` values if the underlying run can no longer be resumed.

- `apps/web/app/sessions/[sessionId]/chats/[chatId]/session-chat-context.tsx`
  - Replace `AbortableChatTransport` with `WorkflowChatTransport`.
  - Use `onChatSendMessage` to read `x-workflow-run-id` and cache the active run ID in client state.
  - Use `prepareReconnectToStreamRequest` to reconnect to the chat stream endpoint with the current `chatId` and AI SDK-provided `startIndex`.
  - Use `onChatEnd` to clear client-side active run tracking.
  - Keep `resume` behavior driven by initial chat state so page refreshes still resume automatically.
  - Re-test current retry/reconnect logic to ensure manual retry and auto-recovery still behave correctly without the old transport wrapper.

- `apps/web/lib/abortable-chat-transport.ts`
  - Remove the old wrapper if `WorkflowChatTransport` fully covers the reconnect path.
  - If hard-abort behavior is still needed for UX parity, replace it with a thin workflow-aware wrapper instead of keeping `DefaultChatTransport` semantics around.

- `apps/web/lib/resumable-stream-context.ts`
  - Remove after the workflow transport is live and no routes import it.

- `apps/web/lib/chunked-publisher-adapter.ts`
  - Remove once resumable-stream Redis publishing is no longer used.

- `apps/web/lib/chunked-publisher-adapter.test.ts`
  - Remove with the adapter.

- `apps/web/package.json`
  - Add `@workflow/ai@4.0.1-beta.52`.
  - Remove `resumable-stream`.
  - Keep `workflow` at the currently installed compatible version unless a later pass intentionally upgrades the workflow stack.

- `apps/web/app/api/chat/route.test.ts`
  - Replace resumable-stream mocks with workflow mocks (`workflow/api.start`, workflow run readable stream, run ID header behavior).
  - Cover the new ownership/run-ID path and ensure post-finish side effects still occur.

- `apps/web/app/api/chat/[chatId]/stream/route.test.ts` (new)
  - Add focused coverage for workflow stream reconnection, including:
    - 204 when there is no active run
    - authenticated resume path with `startIndex`
    - stale-run cleanup behavior

- `packages/agent/tools/tools.test.ts`
  - Update context fixtures to match the new serializable runtime context shape if the tool helpers change.
  - Add coverage that file/shell tools reconnect from `sandboxId` before executing commands.

- `apps/web/app/api/chat/[chatId]/stop/route.ts`
  - Review and adapt stop behavior so it still works after the executor moves into a workflow.
  - At minimum, keep the route contract stable and make the workflow path observe a workflow-safe stop signal between steps/tool executions, rather than relying on a request-local `AbortController` in the old POST route.

- `apps/web/lib/stop-signal.ts`
  - Keep only if it remains the chosen stop-state mechanism for workflow-driven execution.
  - If a different workflow-native stop mechanism is introduced, update or remove this module accordingly.

Implementation order:
- [x] Introduce shared tool exports and serializable runtime types in `packages/agent`.
- [x] Convert the main agent and subagents to DurableAgent factories.
- [x] Update tool utilities and tool execution paths to reconnect from `sandboxId`.
- [x] Decouple web/CLI typing from runtime agent singletons.
- [x] Add the web chat workflow and switch the POST route to workflow execution.
- [x] Switch reconnect logic and client transport to `WorkflowChatTransport`.
- [x] Remove resumable-stream Redis code and update tests.
- [x] Verify message metadata, stop behavior, and task/subagent UI parity before merge.

Verification:
- Automated checks:
  - `bun test packages/agent/tools/tools.test.ts`
  - `bun test apps/web/app/api/chat/route.test.ts`
  - `bun run typecheck`
  - `bun run lint`
  - `bun run ci`
- Add and run a dedicated reconnect route test for `apps/web/app/api/chat/[chatId]/stream/route.ts`.
- Manual end-to-end checks:
  - send a message, refresh mid-stream, and confirm the response resumes without Redis-backed resumable streams
  - run file/shell tools after a reconnect and confirm sandbox access still works from `sandboxId`
  - trigger a subagent task and confirm the existing task UI still shows progressive tool activity and final usage
  - verify repo-authenticated sandbox flows still work after reconnecting from `sandboxId`
  - verify two overlapping chat requests still honor the existing newer-request-wins ownership logic
  - verify stop behavior still interrupts generation or, if intentionally changed, is explicitly documented and accepted
  - verify token usage metadata still appears in web and CLI UIs (`lastStepUsage` / `totalMessageUsage`) and still feeds context-limit heuristics