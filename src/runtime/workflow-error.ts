import { WorkflowFailure, WorkflowFailureCode, WorkflowFailureSchema, WorkflowFailureStage } from './types';

type WorkflowRuntimeErrorInit = {
  code: WorkflowFailureCode;
  message: string;
  stage?: WorkflowFailureStage;
  detail?: string;
  summary?: string;
  flow_id?: string;
  flow_name?: string;
  conflict_entries?: string[];
  target_worldbook_name?: string;
  request_id?: string;
  api_preset_name?: string;
  attempted_flow_count?: number;
  successful_flow_count?: number;
  partial_success?: boolean;
  whole_workflow_failed?: boolean;
  http_status?: number;
  suggestion?: string;
  cause?: unknown;
};

export class WorkflowRuntimeError extends Error {
  readonly failure: WorkflowFailure;
  override readonly cause?: unknown;

  constructor(init: WorkflowRuntimeErrorInit) {
    super(init.message);
    this.name = 'WorkflowRuntimeError';
    this.failure = WorkflowFailureSchema.parse({
      code: init.code,
      stage: init.stage ?? 'unknown',
      detail: init.detail ?? '',
      summary: init.summary ?? init.message,
      flow_id: init.flow_id ?? '',
      flow_name: init.flow_name ?? '',
      conflict_entries: init.conflict_entries ?? [],
      target_worldbook_name: init.target_worldbook_name ?? '',
      request_id: init.request_id ?? '',
      api_preset_name: init.api_preset_name ?? '',
      attempted_flow_count: init.attempted_flow_count ?? 0,
      successful_flow_count: init.successful_flow_count ?? 0,
      partial_success: init.partial_success ?? false,
      whole_workflow_failed: init.whole_workflow_failed ?? true,
      http_status: init.http_status,
      suggestion: init.suggestion ?? getWorkflowFailureSuggestion(init.code, init.stage),
    });
    this.cause = init.cause;
  }
}

export function isWorkflowRuntimeError(error: unknown): error is WorkflowRuntimeError {
  return error instanceof WorkflowRuntimeError;
}

function defaultSummaryForCode(code: WorkflowFailureCode): string {
  switch (code) {
    case 'worldbook_missing':
      return '当前角色没有可写的已绑定世界书，请先绑定角色世界书。';
    case 'entry_conflict':
      return '多个工作流同时写入同名动态条目，本轮写回已阻止。';
    case 'empty_desired_entry':
      return '工作流返回了空的动态条目内容，本轮写回已阻止。';
    case 'response_status_not_ok':
      return '工作流返回 status != ok，本轮执行已中止。';
    case 'no_effective_write':
      return '本轮执行没有产生任何有效写入或回复指令。';
    case 'snapshot_resolution_unsafe':
      return '当前只命中了不安全的历史回退快照，已阻止危险写回。';
    default:
      return '工作流执行失败。';
  }
}

export function getWorkflowFailureSuggestion(
  code?: WorkflowFailureCode,
  stage?: WorkflowFailureStage,
): string {
  switch (code) {
    case 'worldbook_missing':
      return '先在当前角色卡绑定一个可写世界书，再重试本轮工作流。';
    case 'entry_conflict':
      return '检查是否有多条工作流同时覆盖同名动态条目，必要时拆分条目名或改成 add 模式。';
    case 'empty_desired_entry':
      return '检查模型返回是否真的产出了条目正文，必要时收紧 schema 提示词或增加兜底。';
    case 'response_status_not_ok':
      return '检查该工作流的响应状态、提示词约束和上游 API 返回内容。';
    case 'no_effective_write':
      return '确认本轮至少产生世界书写入、控制器写入，或有效的回复指令。';
    case 'snapshot_resolution_unsafe':
      return '请先切回能精确命中快照的消息版本，或使用同划回退/单版回退来源后再执行回滚、恢复或重推导。';
    default:
      break;
  }

  switch (stage) {
    case 'dispatch':
      return '检查 API 预设、模型名、网络连通性和请求超时设置。';
    case 'merge':
      return '检查多工作流输出是否发生同名条目冲突，或返回内容是否不满足合并规则。';
    case 'commit':
      return '检查目标世界书绑定、世界书可读写性以及当前聊天上下文是否仍然有效。';
    case 'semantic':
      return '检查模型返回是否满足约定语义，例如 status=ok 且动态条目内容非空。';
    case 'config':
      return '检查本地配置、模板和运行时依赖是否齐全。';
    default:
      return '';
  }
}

export function extractHttpStatusFromErrorText(errorText: string): number | undefined {
  const match = String(errorText ?? '').match(/\bHTTP\s+(\d{3})\b/i);
  if (!match) {
    return undefined;
  }

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function createWorkflowRuntimeError(
  code: WorkflowFailureCode,
  stage: WorkflowFailureStage,
  overrides: Omit<WorkflowRuntimeErrorInit, 'code' | 'stage' | 'message'> & { message?: string } = {},
): WorkflowRuntimeError {
  return new WorkflowRuntimeError({
    code,
    stage,
    message: overrides.message ?? overrides.summary ?? defaultSummaryForCode(code),
    suggestion: overrides.suggestion ?? getWorkflowFailureSuggestion(code, stage),
    ...overrides,
  });
}

export function getWorkflowFailureFromError(error: unknown): WorkflowFailure | null {
  if (isWorkflowRuntimeError(error)) {
    return error.failure;
  }
  return null;
}
