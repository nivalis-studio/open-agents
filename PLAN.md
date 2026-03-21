Summary: Add a Slack front door using Chat SDK so users can @mention the bot to start a repo-scoped Open Harness session, immediately get the direct web chat link back in Slack, and receive exactly one final reply in the originating Slack thread when the first run finishes naturally. Keep the web chat as the source of truth for all follow-up turns.

Context: Existing web chat already has the core pieces we need: session/chat creation in `apps/web/app/api/sessions/route.ts` and `apps/web/lib/db/sessions.ts`, sandbox provisioning in `apps/web/app/api/sandbox/route.ts`, and agent execution/persistence in `apps/web/app/api/chat/route.ts`, `apps/web/app/workflows/chat.ts`, and `apps/web/app/workflows/chat-post-finish.ts`. Chat turns require an active sandbox before `runAgentWorkflow` can start. The repo already has a `linked_accounts` table plus lookup helpers in `apps/web/lib/db/schema.ts` and `apps/web/lib/db/linked-accounts.ts`, so explicit Slack-to-user mapping is partially paved. There is currently no Slack or Chat SDK code in the repo, so implementation will require adding the Chat SDK packages documented in the Slack guide (`chat`, `@chat-adapter/slack`, `@chat-adapter/state-redis`) plus Slack app/webhook configuration. The direct chat URL already exists at `/sessions/[sessionId]/chats/[chatId]`; public share links under `/shared/[shareId]` are read-only and do not satisfy the “continue in the chat” requirement.

Approach: Use Chat SDK only as the Slack transport layer, not as the source of conversation state. Open Harness sessions/chats remain canonical. Use `@mention` as the Slack trigger. On first use, if the Slack user/workspace is not linked, reply with a signed Open Harness link that binds `provider=slack`, `externalId`, and `workspaceId` to the currently authenticated Open Harness user using the existing `linked_accounts` table. For v1, support a strict repo-prefixed mention syntax (recommended: `owner/repo[#branch] <prompt>`), parse repo/branch/prompt, create a normal session + initial chat, provision the sandbox, persist the initial user message, and start the existing agent workflow. Immediately post the direct chat URL back to the Slack thread. Store Slack thread metadata against the chat so the workflow can send exactly one follow-up message later. When the initial workflow finishes naturally (not paused for tool input/approval, not aborted), extract the assistant text parts, post them back to the same Slack thread, and mark the Slack replyback record complete so later web turns never notify Slack.

Changes:
- `apps/web/lib/db/schema.ts` and a new migration - add a chat-scoped external reply target table for Slack metadata (provider/workspace/channel/thread/message + replyback status) so the first Slack turn can be answered exactly once.
- `apps/web/lib/db/linked-accounts.ts` - add an idempotent upsert-style helper for Slack link confirmation.
- `apps/web/lib/slack/bot.ts` - create the Chat SDK singleton using the Slack adapter and a Redis-backed state adapter wired through existing Redis config.
- `apps/web/lib/slack/repo-parser.ts`, `apps/web/lib/slack/link-token.ts`, `apps/web/lib/slack/session-kickoff.ts`, `apps/web/lib/slack/replyback.ts` - add focused Slack helpers for mention parsing, signed link tokens, session creation/orchestration, and final-thread posting.
- `apps/web/app/api/webhooks/slack/route.ts` - expose the Slack webhook handler.
- `apps/web/app/slack/link/page.tsx` and/or `apps/web/app/api/slack/link/route.ts` - implement the signed link-confirmation flow that associates a Slack user/workspace with the current Open Harness account.
- `apps/web/app/api/sessions/route.ts`, `apps/web/app/api/sandbox/route.ts`, `apps/web/app/api/chat/route.ts` - extract reusable server-side business logic Slack needs so the webhook can call shared helpers instead of making internal HTTP requests or duplicating route logic.
- `apps/web/app/workflows/chat.ts` and/or `apps/web/app/workflows/chat-post-finish.ts` - trigger the one-time Slack final reply after persistence, only for natural finishes, then clear the reply target.

Verification:
- Unit tests for Slack repo parsing, signed link token validation, and Slack replyback gating.
- Route/service tests covering: unlinked Slack user, linked kickoff success, invalid repo syntax, and “link posted immediately”.
- Workflow tests covering: natural finish posts to Slack once, paused/aborted runs do not post, and later web-only turns do not post.
- Manual end-to-end:
  - @mention the bot with `owner/repo[#branch] <prompt>`
  - verify Slack immediately gets the direct chat link
  - verify the web chat opens at `/sessions/{sessionId}/chats/{chatId}`
  - verify the first completed turn posts back to the Slack thread
  - verify a second turn from the web UI does not post back to Slack
- Full validation:
  - `bun run ci`
