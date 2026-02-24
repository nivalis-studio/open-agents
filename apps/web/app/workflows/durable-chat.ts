import type { ModelMessage, UIMessageChunk } from "ai";
import { getWritable } from "workflow";
import type { DurableOpenHarnessAgentCallOptions } from "@open-harness/agent";

/**
 * Durable chat workflow that runs the agent inside the Workflow framework.
 *
 * Called via `start(durableChatWorkflow, [messages, callOptions])` from the
 * `/api/chat-durable` route. The workflow writes `UIMessageChunk`s to a
 * writable stream that the client reads via `WorkflowChatTransport`.
 *
 * The actual agent execution is isolated inside {@link runAgentStep} (a
 * `"use step"` function) so that the workflow bundler does not pull Node.js
 * module dependencies (e.g. `path`, `fs`) into the workflow runtime.
 */
export async function durableChatWorkflow(
  messages: ModelMessage[],
  callOptions: DurableOpenHarnessAgentCallOptions,
) {
  "use workflow";

  const writable = getWritable<UIMessageChunk>();
  const result = await runAgentStep(messages, callOptions, writable);

  return {
    messages: result.messages,
  };
}

/**
 * Step function that constructs and runs the durable agent.
 *
 * By marking this as `"use step"`, the workflow compiler bundles it
 * separately for the Node.js runtime, allowing full access to Node.js
 * built-in modules used by the agent tools.
 */
async function runAgentStep(
  messages: ModelMessage[],
  callOptions: DurableOpenHarnessAgentCallOptions,
  writable: WritableStream<UIMessageChunk>,
) {
  "use step";

  const { DurableAgent } = await import("@workflow/ai/agent");
  const { prepareDurableCall } = await import("@open-harness/agent");

  const { agentOptions, streamOptions } = prepareDurableCall(callOptions);
  const agent = new DurableAgent(agentOptions);

  return agent.stream({
    messages,
    writable,
    ...streamOptions,
  });
}
