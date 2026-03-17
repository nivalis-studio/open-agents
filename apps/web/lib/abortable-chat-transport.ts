import {
  WorkflowChatTransport,
  type WorkflowChatTransportOptions,
} from "@workflow/ai";
import type { UIMessage } from "ai";

/**
 * A workflow chat transport that allows aborting all active fetch connections,
 * including reconnect requests.
 */
export class AbortableChatTransport<
  UI_MESSAGE extends UIMessage = UIMessage,
> extends WorkflowChatTransport<UI_MESSAGE> {
  private state: {
    controller: AbortController;
    reconnectsBlocked: boolean;
  };

  constructor(options: WorkflowChatTransportOptions<UI_MESSAGE>) {
    const state = {
      controller: new AbortController(),
      reconnectsBlocked: false,
    };
    const outerFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

    const wrappedFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const isNewChatRequest = init?.signal !== undefined;

      if (state.reconnectsBlocked) {
        if (!isNewChatRequest) {
          return Promise.reject(
            new DOMException("The operation was aborted.", "AbortError"),
          );
        }

        state.reconnectsBlocked = false;
        state.controller = new AbortController();
      }

      return outerFetch(input, {
        ...init,
        signal: init?.signal
          ? AbortSignal.any([state.controller.signal, init.signal])
          : state.controller.signal,
      });
    }) as unknown as typeof fetch;

    super({
      ...options,
      fetch: wrappedFetch,
    });

    this.state = state;
  }

  abort(): void {
    this.state.reconnectsBlocked = true;
    this.state.controller.abort();
  }

  reset(): void {
    this.state.reconnectsBlocked = false;
    this.state.controller = new AbortController();
  }
}
