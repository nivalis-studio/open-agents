import type { ApprovalConfig } from "@open-harness/agent";

export const WEB_AGENT_APPROVAL: ApprovalConfig = {
  type: "interactive",
  autoApprove: "all",
  sessionRules: [],
};
