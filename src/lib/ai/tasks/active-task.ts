/**
 * Active Task Continuation — 多轮 Task 的「回答绑定」层
 *
 * 解决的问题：
 * AI 上一轮问了「面巾纸放在哪里？大概多久用完？」，用户回「放在储物间」时，
 * 这句话本身不含任何 Action 关键词。如果继续走 routeAITask，它会被判定成 chat，
 * 然后被 LLM 当成闲聊回答 —— 多轮收集永远闭不了环。
 *
 * 职责边界：
 * - 只做「用户回复 → 进行中的 Task 草稿」的绑定，不做意图发现（那是 task-router 的事）。
 * - 纯函数：不读写 localStorage，不发请求。
 * - 只有 add_consumable 有真正的多轮收集；其它 task 走 confirmation UI，不经过这里。
 *
 * 打断策略（Draft Interrupt Policy）：
 * 调用方在进入本模块之前，必须先确认这条消息没有命中新的明确 Action Task。
 * 例如收集消耗品期间用户说「明天帮我买包纸巾」，应当打断并切到 add_shopping_item，
 * 而不是把这句话塞进消耗品草稿。
 */

import type {
  ActiveTaskSnapshot,
  AITaskContext,
  AITaskExtraction,
  AITaskType,
  CardCommand,
  CardKind,
  ConsumableDraft,
  ConsumableSessionPhase,
  ShoppingItemDraft
} from './types';
import {
  applyConsumableSessionReply,
  mergeConsumableDrafts
} from './consumable-session';
import { extractInitialConsumableDrafts } from './consumable-task';
import {
  applyShoppingFieldReply,
  extractShoppingItems,
  mergeShoppingDrafts,
  buildShoppingDraftSummary
} from './shopping-task';
import { detectItemRemoval, readPurchaseCancellation } from './action-guard';

export type { ActiveTaskSnapshot } from './types';

/** 只有仍在收集字段的消耗品任务才需要续采；confirming 阶段交给确认卡片 */
export function hasActiveConsumableSession(
  activeTask?: ActiveTaskSnapshot
): boolean {
  if (!activeTask) return false;
  if (activeTask.taskType !== 'add_consumable') return false;
  if (activeTask.consumablePhase === 'confirming') return false;
  return (activeTask.consumableDrafts ?? []).length > 0;
}

/** 采购清单会话：卡片已渲染，用户可以直接用一句话补时间/预算 */
export function hasActiveShoppingSession(
  activeTask?: ActiveTaskSnapshot
): boolean {
  if (!activeTask) return false;
  if (activeTask.taskType !== 'add_shopping_item') return false;
  return (activeTask.shoppingDrafts ?? []).length > 0;
}

/**
 * 把用户回复绑定到进行中的消耗品会话上。
 *
 * 同一句话里可能又冒出新的消耗品（「还有洗洁精，都放厨房」），
 * 因此先合并新识别出的条目，再统一做字段绑定。
 */
export function continueConsumableTask(
  activeTask: ActiveTaskSnapshot,
  context: AITaskContext
): AITaskExtraction {
  const existing = activeTask.consumableDrafts ?? [];

  // 条目级移除先行（与采购会话同一判据）：「洗衣液别记了」不是补字段。
  const removal = detectItemRemoval(context.message, existing);
  if (removal.matched.length > 0 || removal.unknown.length > 0) {
    const kept = existing.filter((d) => !removal.matched.includes(d.name));
    const removedNames = removal.matched.join('、');
    const replyText =
      removal.matched.length === 0
        ? `消耗品登记里还没有${removal.unknown.join('、')}，先不动这张卡。`
        : kept.length > 0
          ? `好，把${removedNames}拿掉了，还要登记：${kept.map((d) => d.name).join('、')}。`
          : '好，这次先不登记了。';
    return {
      intent: {
        taskType: 'add_consumable',
        confidence: 0.95,
        reason: '取消：移除指定登记项'
      },
      drafts: { items: kept },
      replyText,
      requiresConfirmation: true,
      consumablePhase: 'collecting',
      ...(kept.length === 0 && removal.matched.length > 0
        ? { cardCommand: 'cancel' as const }
        : {})
    };
  }

  const incoming = extractInitialConsumableDrafts(context.message);
  const merged = mergeConsumableDrafts(existing, incoming);
  const session = applyConsumableSessionReply(merged, context.message);

  return {
    intent: {
      taskType: 'add_consumable',
      confidence: 0.95,
      reason:
        incoming.length > 0
          ? `续采：并入 ${incoming.length} 个新消耗品后绑定字段`
          : '续采：绑定到进行中的消耗品会话'
    },
    drafts: { items: session.drafts },
    replyText: session.replyText,
    requiresConfirmation: true,
    consumablePhase: session.phase
  };
}

/**
 * 把用户回复绑定到进行中的采购会话上。
 *
 * 「明天买，预算20块」这句话没有任何物品名，走 router 会被判成
 * 空 add_shopping_item（"可以告诉我你想买什么吗？"）。这里把它并入
 * 当前会话的草稿，让 Shopping Draft 保持唯一数据源。
 */
export function continueShoppingTask(
  activeTask: ActiveTaskSnapshot,
  context: AITaskContext
): AITaskExtraction {
  const existing = activeTask.shoppingDrafts ?? [];

  // 条目级移除先行：「纸巾不要了」不是补字段，更不是新商品。
  // 若落到下面的续采合并，剥离否定词后剩下的物品名会被当成正向采购条目，
  // 用户刚说不要、卡片里反而多出一条 —— 移除命中即终结本轮，不再走提取。
  const removal = detectItemRemoval(context.message, existing);
  if (removal.matched.length > 0 || removal.unknown.length > 0) {
    const kept = existing.filter((d) => !removal.matched.includes(d.name));
    const removedNames = removal.matched.join('、');
    const replyText =
      removal.matched.length === 0
        ? `采购清单里还没有${removal.unknown.join('、')}，先不动这张卡。`
        : kept.length > 0
          ? `好，把${removedNames}从采购计划里拿掉了，还要买：${kept.map((d) => d.name).join('、')}。`
          : `好，${removedNames}先不买了。`;
    return {
      intent: {
        taskType: 'add_shopping_item',
        confidence: 0.95,
        reason: '取消：移除指定采购项'
      },
      drafts: { items: kept },
      replyText,
      requiresConfirmation: true,
      // 全部移除 = 这张卡办完了：口令等价于点击取消按钮，
      // 由前端把旧卡翻成已取消，不给它留二次提交的机会。
      ...(kept.length === 0 && removal.matched.length > 0
        ? { cardCommand: 'cancel' as const }
        : {})
    };
  }

  // 整句放弃采购（「那算了，不买了」）：没有点名的条目，摘不掉具体某一条，
  // 就把这张卡整体作废。必须停在字段补全之前 —— 否则「不买了」会被
  // applyShoppingFieldReply 当成一句字段、被 extractShoppingItems 当成一件商品。
  if (readPurchaseCancellation(context.message)) {
    return {
      intent: {
        taskType: 'add_shopping_item',
        confidence: 0.95,
        reason: '取消：放弃本次采购'
      },
      drafts: { items: [] },
      replyText: '好，这次先不买了。',
      requiresConfirmation: true,
      cardCommand: 'cancel'
    };
  }

  const withFields = applyShoppingFieldReply(existing, context.message);
  const incoming = extractShoppingItems(context.message);
  const merged = mergeShoppingDrafts(withFields, incoming);

  return {
    intent: {
      taskType: 'add_shopping_item',
      confidence: 0.95,
      reason:
        incoming.length > 0
          ? `续采：并入 ${incoming.length} 个新采购物品后补全字段`
          : '续采：补全进行中的采购草稿'
    },
    drafts: { items: merged },
    replyText: buildShoppingDraftSummary(merged),
    requiresConfirmation: true
  };
}

/* ------------------------------------------------------------------ *
 * Continuation 状态机（前端唯一入口）
 *
 * 放在 lib 层而不是内联在 page.tsx，是为了让「API 响应 → activeTask」和
 * 「历史消息 → activeTask」两条推导只有一份实现：页面与 harness 调用的是
 * 同一个函数，测过的就是跑着的。
 * ------------------------------------------------------------------ */

/** API 响应里 task 字段的结构子集（不依赖 @/lib/types/chat，避免循环引用） */
interface ResponseTaskPayload {
  taskType: AITaskType;
  consumableDrafts?: ConsumableDraft[];
  consumablePhase?: ConsumableSessionPhase;
  shoppingDrafts?: ShoppingItemDraft[];
  /** 用户用打字代替了点按钮：卡片已经处理完，会话到此为止 */
  cardCommand?: CardCommand;
}

/**
 * 哪张卡片正在等用户点头。
 *
 * - 消耗品：字段收齐进入 confirming 之后
 * - 采购：草稿还在、没被确认也没被取消
 *
 * 返回 null 表示当前没有可被「确认 / 算了」这句话操作的卡片。
 */
export function pendingCardOf(
  activeTask?: ActiveTaskSnapshot
): CardKind | null {
  if (!activeTask) return null;
  if (activeTask.taskType === 'add_consumable') {
    return activeTask.consumablePhase === 'confirming' &&
      (activeTask.consumableDrafts ?? []).length > 0
      ? 'consumable'
      : null;
  }
  if (activeTask.taskType === 'add_shopping_item') {
    return (activeTask.shoppingDrafts ?? []).length > 0 ? 'shopping' : null;
  }
  return null;
}

/**
 * 一轮响应结束后，进行中的会话应该变成什么。
 *
 * - add_consumable / add_shopping_item → 保存草稿与阶段，下一句可续采
 * - update_consumable_status 带补货草稿 → 交给采购会话（复用同一张确认卡）
 * - 卡片口令（确认/取消）→ 会话已结束
 * - 其它任何 Task（含 chat）→ 视为用户改口，结束当前会话
 */
export function nextActiveTask(
  task?: ResponseTaskPayload
): ActiveTaskSnapshot | null {
  if (!task) return null;
  if (task.cardCommand) return null;

  if (task.taskType === 'add_consumable') {
    return {
      taskType: 'add_consumable',
      consumableDrafts: task.consumableDrafts ?? [],
      consumablePhase: task.consumablePhase ?? 'collecting'
    };
  }

  if (task.taskType === 'add_shopping_item') {
    return {
      taskType: 'add_shopping_item',
      shoppingDrafts: task.shoppingDrafts ?? []
    };
  }

  if (
    task.taskType === 'update_consumable_status' &&
    (task.shoppingDrafts?.length ?? 0) > 0
  ) {
    return {
      taskType: 'add_shopping_item',
      shoppingDrafts: task.shoppingDrafts
    };
  }

  return null;
}

/** 历史消息中与 continuation 相关的字段（结构子集，ChatMessage 天然满足） */
export interface PersistedTaskMessage {
  role: 'user' | 'assistant';
  taskType?: AITaskType;
  taskResolved?: 'committed' | 'cancelled';
  consumableDrafts?: ConsumableDraft[];
  consumablePhase?: ConsumableSessionPhase;
  shoppingDrafts?: ShoppingItemDraft[];
}

/**
 * 刷新页面后恢复进行中的多轮 Task。服务端无状态，续采全靠前端回传。
 *
 * 只恢复还活着的会话：taskResolved 有值（已确认 / 已取消）的消息一律跳过，
 * 否则一个早已办完的 Task 会在刷新后重新劫持聊天。
 */
export function deriveActiveTask(
  messages: readonly PersistedTaskMessage[]
): ActiveTaskSnapshot | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== 'assistant' || m.taskResolved) continue;

    if (m.taskType === 'add_consumable' && (m.consumableDrafts?.length ?? 0) > 0) {
      return {
        taskType: 'add_consumable',
        consumableDrafts: m.consumableDrafts,
        consumablePhase: m.consumablePhase ?? 'collecting'
      };
    }

    // 采购卡片不认 taskType：补货派生的草稿挂在 update_consumable_status 消息上，
    // 但它的会话语义和普通 add_shopping_item 完全一致。
    if ((m.shoppingDrafts?.length ?? 0) > 0) {
      return {
        taskType: 'add_shopping_item',
        shoppingDrafts: m.shoppingDrafts
      };
    }
  }
  return null;
}