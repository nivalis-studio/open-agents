type ResumableStreamContext = {
  createNewResumableStream: <T>(
    _streamId: string,
    streamFactory: () => ReadableStream<T>,
  ) => Promise<ReadableStream<T>>;
  resumeExistingStream: (_streamId: string) => Promise<null>;
};

/**
 * Deprecated noop compatibility shim kept only until all legacy imports are removed.
 * Workflow-backed chat streaming no longer depends on Redis resumable streams.
 */
export const resumableStreamContext: ResumableStreamContext = {
  createNewResumableStream: async (_streamId, streamFactory) => streamFactory(),
  resumeExistingStream: async () => null,
};
