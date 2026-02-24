import { openHarnessAgent } from "@open-harness/agent";

// The non-durable agent is still used for `convertToModelMessages` (which
// needs the tool definitions) and as a fallback reference.  The web app's
// chat transport now points at the `/api/chat-durable` route which uses
// the durable workflow in `app/workflows/durable-chat.ts`.
export const webAgent = openHarnessAgent;
