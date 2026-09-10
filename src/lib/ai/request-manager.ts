/**
 * Qingshe AI Request Manager
 *
 * 设计目标：
 * - AI 请求生命周期不依赖任何 React 组件的 mount 状态。
 * - 同一时刻可以存在多个 in-flight 请求，按 requestId 精确关联到对应用户消息。
 * - 乱序返回（Request B 先返回、Request A 后返回）不会串回复。
 * - 不重复发送。
 * - 浏览器刷新后能识别孤儿 pending 并安全清理，不造成"永久 pending"。
 *
 * 持久化原则：
 * - 聊天消息仍以 qingshe_ai_messages 为唯一数据源。
 * - qingshe_ai_pending_requests 只保存 lifecycle metadata：
 *   { requestId, userMessageId, createdAt }，不保存请求体。
 * - 用户消息在 sendRequest 之前已经被调用方写入 messages 与 storage，
 *   manager 不重复写入用户消息。
 */

import type { ChatApiResponse, ChatMessage, ChatRequestBody } from '@/lib/types/chat';

const PENDING_KEY = 'qingshe_ai_pending_requests';

export interface PendingRequestMeta {
  requestId: string;
  userMessageId: string;
  createdAt: string;
}

export interface SendRequestCallbacks {
  /**
   * 当 AI 响应成功时由 manager 调用。调用方应：
   * 1. 更新 messages 中 userMessageId 对应的 assistant 消息
   * 2. 将 messages 持久化到 qingshe_ai_messages
   */
  onAssistantComplete: (
    userMessageId: string,
    requestId: string,
    response: ChatApiResponse
  ) => void;

  /**
   * 当 AI 请求失败时由 manager 调用。调用方应：
   * 1. 在 messages 中标记对应 assistant 消息为 failed
   * 2. 持久化到 qingshe_ai_messages
   */
  onAssistantFailed: (userMessageId: string, requestId: string, error: Error) => void;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

function readPending(): PendingRequestMeta[] {
  if (!isBrowser()) return [];
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingRequestMeta[]) : [];
  } catch {
    return [];
  }
}

function writePending(list: PendingRequestMeta[]): void {
  if (!isBrowser()) return;
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
}

function appendPending(meta: PendingRequestMeta): void {
  const list = readPending();
  list.push(meta);
  writePending(list);
}

function removePending(requestId: string): void {
  const list = readPending();
  const next = list.filter((item) => item.requestId !== requestId);
  writePending(next);
}

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export interface SendRequestInput {
  userMessageId: string;
  body: ChatRequestBody;
  callbacks: SendRequestCallbacks;
  /**
   * 可选：注入 fetch。默认使用全局 fetch。
   * 主要便于测试与未来扩展。
   */
  fetcher?: typeof fetch;
}

export interface SendRequestResult {
  requestId: string;
}

/**
 * 发送一次 AI 请求。
 *
 * 该函数立即返回 requestId，AI 响应在后台到达后通过 callbacks 通知调用方。
 * 不依赖任何 React 组件的存活状态。
 */
export function sendRequest(input: SendRequestInput): SendRequestResult {
  const requestId = generateRequestId();
  const createdAt = new Date().toISOString();
  const fetcher = input.fetcher ?? fetch;

  appendPending({
    requestId,
    userMessageId: input.userMessageId,
    createdAt
  });

  // 立即发起 fetch。manager 不持有组件引用，不调用 setState。
  // fetch 自身在浏览器中不会因为页面 unmount 而被强制 abort。
  fetcher('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input.body)
  })
    .then(async (response) => {
      const raw = await response.json().catch(() => ({}));
      if (!response.ok) {
        const errMsg =
          (raw as { error?: string })?.error || `Request failed: ${response.status}`;
        throw new Error(errMsg);
      }
      return raw as ChatApiResponse;
    })
    .then((data) => {
      removePending(requestId);
      input.callbacks.onAssistantComplete(input.userMessageId, requestId, data);
    })
    .catch((err: unknown) => {
      removePending(requestId);
      const error =
        err instanceof Error ? err : new Error('Unknown AI request error');
      input.callbacks.onAssistantFailed(input.userMessageId, requestId, error);
    });

  return { requestId };
}

/**
 * 页面挂载时调用。
 * 找出 storage 中所有仍在 pending 的 metadata；
 * 对于超过 5 分钟且消息列表中对应 userMessage 仍没有 completed/failed assistant 跟随的请求：
 *   - 标记 userMessage 之后的 assistant 占位为 failed
 *   - 从 pending storage 中清理
 *
 * 不会自动重新发送请求。目标：消除"永久 pending"卡死。
 */
export interface ReconcileOnMountInput {
  messages: ChatMessage[];
  /**
   * 调用方应：将 messages 中指定 userMessageId 之后插入的 assistant 占位标记为 failed；
   * 或者对仍处于 pending 的 assistant 直接更新 status = 'failed'。
   * 然后将 messages 写回 storage。
   */
  onMarkFailed: (userMessageId: string, requestId: string) => void;
  /** 超过该时长（毫秒）视为孤儿。默认 5 分钟。 */
  orphanTimeoutMs?: number;
}

const DEFAULT_ORPHAN_TIMEOUT_MS = 5 * 60 * 1000;

export function reconcilePendingOnMount(input: ReconcileOnMountInput): void {
  const pending = readPending();
  if (pending.length === 0) return;

  const now = Date.now();
  const orphanTimeout = input.orphanTimeoutMs ?? DEFAULT_ORPHAN_TIMEOUT_MS;
  const messageIds = new Set(input.messages.map((m) => m.id));

  for (const meta of pending) {
    const age = now - new Date(meta.createdAt).getTime();
    // 如果对应的 userMessage 都不存在了（被清空对话等），直接清理 pending
    if (!messageIds.has(meta.userMessageId)) {
      removePending(meta.requestId);
      continue;
    }

    // 检查该 userMessage 之后是否已经有 assistant 完成
    const userIdx = input.messages.findIndex((m) => m.id === meta.userMessageId);
    if (userIdx < 0) {
      removePending(meta.requestId);
      continue;
    }
    const after = input.messages.slice(userIdx + 1);
    const hasCompletedAssistant = after.some(
      (m) => m.role === 'assistant' && (m.status === 'completed' || m.status === undefined)
    );

    if (hasCompletedAssistant) {
      // 已经成功完成（可能跨页面完成），只是 pending metadata 漏清
      removePending(meta.requestId);
      continue;
    }

    if (age > orphanTimeout) {
      // 视为孤儿：不再重新发送，标记为失败
      input.onMarkFailed(meta.userMessageId, meta.requestId);
      removePending(meta.requestId);
    }
    // 否则仍可能正在 in-flight，等待正常 resolve/reject。
  }
}

/**
 * 供调用方在清空对话或重置时清理 pending storage。
 */
export function clearPendingRequests(): void {
  writePending([]);
}

/**
 * 调试 / 测试使用：返回当前 pending 列表的快照。
 */
export function listPendingRequests(): PendingRequestMeta[] {
  return readPending();
}