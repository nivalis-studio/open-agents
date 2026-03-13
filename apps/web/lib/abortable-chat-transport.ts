import type { UIMessage } from "ai";
import {
  WorkflowChatTransport,
  type WorkflowChatTransportOptions,
} from "@workflow/ai";

/**
 * A workflow-aware chat transport that allows aborting every active fetch,
 * including reconnect requests.
 *
 * WorkflowChatTransport already handles resumable workflow streams; this thin
 * wrapper only restores the hard-abort behavior the UI depends on for route
 * teardown and explicit stop actions.
 */
export class AbortableWorkflowChatTransport<
  UI_MESSAGE extends UIMessage = UIMessage,
> extends WorkflowChatTransport<UI_MESSAGE> {
  private state: { controller: AbortController };

  constructor(options: WorkflowChatTransportOptions<UI_MESSAGE> = {}) {
    const state = { controller: new AbortController() };
    const outerFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

    super({
      ...options,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        outerFetch(input, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([state.controller.signal, init.signal])
            : state.controller.signal,
        })) as typeof fetch,
    });

    this.state = state;
  }

  abort(): void {
    this.state.controller.abort();
    this.state.controller = new AbortController();
  }
}
