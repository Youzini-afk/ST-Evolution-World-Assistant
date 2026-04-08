import { getSTContext } from "../st-adapter";
import { setUnsupportedContextReason } from "./host-status";

export type WorkflowSupportStatus =
  | {
      ok: true;
      context: "single_character_chat";
      message: "";
    }
  | {
      ok: false;
      context: "group_chat" | "no_active_character";
      reason: "group_chat_unsupported" | "no_active_character";
      message: string;
    };

export class UnsupportedWorkflowContextError extends Error {
  readonly reason: "group_chat_unsupported" | "no_active_character";

  constructor(
    reason: "group_chat_unsupported" | "no_active_character",
    message: string,
  ) {
    super(message);
    this.name = "UnsupportedWorkflowContextError";
    this.reason = reason;
  }
}

export function getWorkflowSupportStatus(): WorkflowSupportStatus {
  const ctx = getSTContext() as Record<string, any>;
  const groupId = String(ctx.selectedGroupId ?? ctx.groupId ?? "").trim();
  if (groupId) {
    setUnsupportedContextReason("group_chat_unsupported");
    return {
      ok: false,
      context: "group_chat",
      reason: "group_chat_unsupported",
      message:
        "Evolution World Assistant 当前仅支持单角色聊天，暂不支持群聊上下文。",
    };
  }

  const characterId = Number(ctx.characterId);
  const characters = Array.isArray(ctx.characters) ? ctx.characters : [];
  if (!Number.isFinite(characterId) || characterId < 0 || !characters[characterId]) {
    setUnsupportedContextReason("no_active_character");
    return {
      ok: false,
      context: "no_active_character",
      reason: "no_active_character",
      message:
        "Evolution World Assistant 当前没有检测到可写入世界书的活动角色。",
    };
  }

  setUnsupportedContextReason(null);
  return {
    ok: true,
    context: "single_character_chat",
    message: "",
  };
}

export function assertWorkflowSupport(): void {
  const status = getWorkflowSupportStatus();
  if (!status.ok) {
    throw new UnsupportedWorkflowContextError(status.reason, status.message);
  }
}

export function isUnsupportedWorkflowContextError(
  error: unknown,
): error is UnsupportedWorkflowContextError {
  return error instanceof UnsupportedWorkflowContextError;
}
