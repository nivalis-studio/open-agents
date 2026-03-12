import { describe, expect, test } from "bun:test";
import {
  AUTO_COMMIT_POST_TURN_POLL_DELAYS_MS,
  COMPLETED_TURN_FOLLOW_UP_REFRESH_DELAY_MS,
  getPostTurnRefreshDelays,
} from "./post-turn-refresh-polling";

describe("post turn refresh polling", () => {
  test("does not schedule follow-up refreshes without repo context", () => {
    expect(
      getPostTurnRefreshDelays({
        hasRepoContext: false,
        autoCommitPushEnabled: false,
      }),
    ).toEqual([]);

    expect(
      getPostTurnRefreshDelays({
        hasRepoContext: false,
        autoCommitPushEnabled: true,
      }),
    ).toEqual([]);
  });

  test("schedules only the standard follow-up refresh when auto commit is off", () => {
    expect(
      getPostTurnRefreshDelays({
        hasRepoContext: true,
        autoCommitPushEnabled: false,
      }),
    ).toEqual([COMPLETED_TURN_FOLLOW_UP_REFRESH_DELAY_MS]);
  });

  test("adds delayed polling after 5 seconds when auto commit is on", () => {
    expect(
      getPostTurnRefreshDelays({
        hasRepoContext: true,
        autoCommitPushEnabled: true,
      }),
    ).toEqual([
      COMPLETED_TURN_FOLLOW_UP_REFRESH_DELAY_MS,
      ...AUTO_COMMIT_POST_TURN_POLL_DELAYS_MS,
    ]);
  });
});
