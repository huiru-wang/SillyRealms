import type {StageMessage, StageRun, StageSnapshot} from '../stage-contract.js';

const stopped: Record<string, string> = {
  cancelled: '已停止生成。',
  server_shutdown: '服务已关闭，本轮生成已停止。',
  provider_error: '模型服务返回错误，本轮生成已停止。',
  provider_aborted: '模型服务中断了本轮生成。',
  provider_context_window_exceeded: '本轮内容超过模型上下文容量。',
  output_incomplete: '模型输出未完整结束。',
  model_output_invalid: '模型未返回有效正文。',
  model_not_found: '当前模型不可用。',
  model_capability_unsupported: '当前模型不支持所需能力。',
  credential_not_configured: '当前模型尚未配置密钥。',
  credential_unavailable: '当前模型密钥暂不可用。',
  summary_capacity_exceeded: '历史摘要后仍超出上下文预算。',
  context_budget_exceeded: '当前上下文超出预算。',
  invalid_context: '当前会话配置无法构建上下文。',
  tool_execution_unsupported: '本轮模型返回了尚不支持的工具调用。',
  tip_conflict: '会话已更新，本轮生成已停止。',
  session_deleted: '会话已删除。',
  message_persist_failed: '本轮消息未能保存。',
  internal_error: '本轮生成遇到错误并已停止。',
};

/** Presentation follows ServerV2 outcomes. Capability diagnostics never change a completed run. */
export function runNotice(run: StageRun): string | null {
  if (run.status === 'stopping') return '正在停止生成…';
  if (run.status === 'running') return run.phase === 'summarizing' ? '正在整理历史摘要…'
    : run.phase === 'preparing' ? '正在准备上下文…' : '正在生成故事…';
  if (run.status === 'stopped') return stopped[run.stopReason ?? ''] ?? '本轮生成已停止。';
  if (run.status === 'unknown') return '此轮运行状态未确定，当前显示已保存的消息。';
  return null;
}

/** Explain a display-only gap without changing the underlying run outcome. */
export function streamNotice(snapshot: Pick<StageSnapshot, 'streamIncomplete'>): string | null {
  return snapshot.streamIncomplete ? '本轮内容尚未完整同步，当前显示可能缺少连接中断期间的输出。' : null;
}

export function messageNotice(message: StageMessage, status: StageRun['status']): string | null {
  if (message.role !== 'assistant' || message.content.trim()) return null;
  if (message.reasoning_content?.trim()) return message.saved
    ? '已保存的这条消息只有思考内容，没有正文。' : '已收到思考内容，尚未收到正文。';
  if (message.tool_calls?.length) return '模型返回了工具调用，当前会话不执行工具。';
  return status === 'running' || status === 'stopping' ? '正在等待正文…' : '本条消息没有可显示的正文。';
}
