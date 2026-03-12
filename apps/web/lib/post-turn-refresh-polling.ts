export const COMPLETED_TURN_FOLLOW_UP_REFRESH_DELAY_MS = 3_000;
export const AUTO_COMMIT_POST_TURN_POLL_DELAYS_MS = [
  5_000, 10_000, 15_000,
] as const;

type GetPostTurnRefreshDelaysOptions = {
  hasRepoContext: boolean;
  autoCommitPushEnabled: boolean;
};

export function getPostTurnRefreshDelays({
  hasRepoContext,
  autoCommitPushEnabled,
}: GetPostTurnRefreshDelaysOptions): number[] {
  if (!hasRepoContext) {
    return [];
  }

  if (!autoCommitPushEnabled) {
    return [COMPLETED_TURN_FOLLOW_UP_REFRESH_DELAY_MS];
  }

  return [
    COMPLETED_TURN_FOLLOW_UP_REFRESH_DELAY_MS,
    ...AUTO_COMMIT_POST_TURN_POLL_DELAYS_MS,
  ];
}
