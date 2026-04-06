Summary: Migrate session sandboxes from changing runtime IDs plus per-session snapshots to named persistent sandboxes using `session_<sessionId>`, while keeping the current explicit Resume UX and lazily migrating legacy snapshot-backed sessions the first time they resume.

Context:
- The current sandbox abstraction is snapshot-centric: runtime state uses `sandboxId`, restore uses `snapshotId`, and session persistence is split between `sandboxState` and `snapshotUrl`.
- Per-session snapshotting currently happens in the lifecycle/archive flows and in the snapshot API.
- The UI resume flow is driven by whether the session has a saved snapshot.
- Vercel persistent sandboxes replace per-session snapshot churn with a stable sandbox name plus ephemeral sessions.
- The base image snapshot used for fresh environments stays separate; this migration only changes per-session persistence.
- Product decisions for this migration:
  - sandbox names should be `session_<sessionId>`
  - Resume remains explicit, not automatic
  - legacy hibernated sessions migrate lazily on first resume
  - no special handling for legacy live `sbx_*` sandboxes
  - do not explicitly delete sandboxes during archive; let Vercel manage retention

System Impact:
- Source of truth moves to a persistent sandbox name stored in `sandboxState` (for example `sandboxName: "session_<id>"`), plus transient runtime metadata like `expiresAt`.
- `snapshotUrl` becomes a legacy migration field instead of the normal paused-state mechanism.
- Hibernation/archive stop the current persistent sandbox session instead of creating a new per-session snapshot.
- Resume first tries `sandboxName`; if absent but a legacy `snapshotUrl` exists, the app creates `session_<sessionId>` from that snapshot, saves the new sandbox name, and clears the legacy snapshot field.
- Dependent paths include create/reconnect/status/extend/restore APIs, lifecycle orchestration, archive flow, sandbox utility guards, skills cache scoping, and the chat resume UI.

Approach:
- Keep the existing product behavior and lifecycle model, but swap the persistence primitive from snapshot IDs to named persistent sandboxes.
- Treat persistent sandbox names as the durable identity and current sessions as disposable runtime instances.
- Keep the existing resume endpoint/UI shape as a compatibility shim so the frontend does not need a product-level rewrite.
- Leave legacy snapshot restore support only as a one-time lazy migration path.
- Do not build a bridge for old live `sbx_*` sandboxes; the low-user/low-active-sandbox environment does not justify the added complexity.
- In this migration, rely on Vercel-managed retention instead of explicitly deleting persistent sandboxes during archive flows.

Changes:
- `packages/sandbox/package.json` - move to the beta `@vercel/sandbox` SDK.
- `packages/sandbox/vercel/state.ts` - add `sandboxName` as the durable identifier and keep `snapshotId` only for legacy restore input.
- `packages/sandbox/vercel/config.ts` - update config types for named persistent sandboxes.
- `packages/sandbox/vercel/connect.ts` - create/get sandboxes by name, resume by name, and only use snapshot restore for legacy migration.
- `packages/sandbox/vercel/sandbox.ts` - wrap the beta SDK’s name-based API, expose name-based state from `getState()`, and preserve timeout tracking around resumed sessions.
- `packages/sandbox/factory.ts` - update shared sandbox state/connect plumbing to use `sandboxName`.
- `apps/web/app/api/sandbox/route.ts` - create/reconnect using `session_<sessionId>` and make creation idempotent against an existing named sandbox.
- `apps/web/lib/sandbox/utils.ts` - update runtime/resumable state guards to understand `sandboxName` instead of `sandboxId`.
- `apps/web/lib/sandbox/lifecycle.ts` - replace normal snapshot hibernation with `stop()` on the named persistent sandbox and preserve resumable state via `sandboxName`.
- `apps/web/lib/sandbox/archive-session.ts` - stop the persistent sandbox on archive instead of snapshotting it; do not explicitly delete it.
- `apps/web/app/api/sandbox/snapshot/route.ts` - keep the endpoint as the compatibility layer for pause/resume; resume by `sandboxName` when present, otherwise lazily migrate legacy `snapshotUrl` into `session_<sessionId>`.
- `apps/web/app/api/sandbox/reconnect/route.ts` - reconnect/resume/probe using name-based state and clear only transient runtime metadata when unavailable.
- `apps/web/app/api/sandbox/status/route.ts` and `apps/web/app/api/sandbox/extend/route.ts` - reflect name-based persistent state and resumed-session expiry.
- `apps/web/app/sessions/[sessionId]/chats/[chatId]/session-chat-context.tsx` - derive resumable state from `sandboxName || snapshotUrl` and preserve explicit Resume behavior.
- `apps/web/app/sessions/[sessionId]/chats/[chatId]/session-chat-content.tsx` - keep the same Resume button/restore flow while routing through the new named-sandbox behavior.
- `apps/web/lib/skills-cache.ts` - scope cache keys by `sandboxName`, falling back to legacy snapshot IDs only for migration.
- `apps/web/lib/db/sessions.ts` - normalize any legacy sandbox state shape needed during rollout.
- Tests under `packages/sandbox/vercel` and `apps/web/app/api/sandbox`, plus lifecycle/archive tests - update for name-based state and lazy legacy migration.

Verification:
- New session creation stores `sandboxName: "session_<sessionId>"` and does not rely on a per-session snapshot.
- Pausing/hibernating an active session stops the persistent sandbox session and leaves the session resumable without writing a new `snapshotUrl`.
- Resuming a paused persistent sandbox restores the same filesystem and still requires an explicit user Resume action.
- A legacy hibernated session with only `snapshotUrl` lazily migrates on first resume: create named sandbox from snapshot, persist `sandboxName`, clear legacy snapshot state, and continue normally afterward.
- A legacy live `sbx_*` sandbox is not specially migrated in this rollout.
- Run `bun run ci` after implementation.
