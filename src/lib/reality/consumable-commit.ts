/**
 * 消耗品落地编排（确认卡片与聊天口令共用的唯一写入者）
 *
 * 为什么单独成模块：
 * 「登记消耗品」从来不是一次写入 —— 物品进 qingshe_consumables，
 * 补货节奏同时进 qingshe_reminders。这段规则如果留在卡片组件里，
 * 用户在输入框回「确认」时就没有第二条能落地的路径。
 *
 * 输入类型刻意本地声明：reality 层不依赖 ai 层，结构兼容即可。
 */

import type { ConsumableItem } from '@/lib/types/consumable';
import { addConsumables, loadConsumables } from './consumables';
import { addReminders, createReminder, loadReminders } from './reminders';
import { planConsumableReminders } from './consumable-reminders';

export interface ConsumableCommitInput {
  name: string;
  /** 与 ConsumableItem 一致：草稿阶段允许「两包」这类原文，由卡片负责改成数字 */
  quantity?: number | string;
  unit?: string;
  location?: string;
  estimatedRunOutDays?: number;
  checkIntervalDays?: number;
}

export interface ConsumableCommitResult {
  items: ConsumableItem[];
  reminderCount: number;
}

export function commitConsumables(
  drafts: ConsumableCommitInput[]
): ConsumableCommitResult {
  const now = new Date().toISOString();
  const named = drafts.filter((draft) => draft.name.trim().length > 0);
  const items: ConsumableItem[] = named.map((draft, index) => ({
    id: `consumable_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`,
    name: draft.name.trim(),
    ...(draft.quantity != null ? { quantity: draft.quantity } : {}),
    ...(draft.unit ? { unit: draft.unit } : {}),
    ...(draft.location ? { location: draft.location } : {}),
    ...(draft.estimatedRunOutDays != null
      ? { estimatedRunOutDays: draft.estimatedRunOutDays }
      : {}),
    ...(draft.checkIntervalDays != null
      ? { checkIntervalDays: draft.checkIntervalDays }
      : {}),
    status: draft.estimatedRunOutDays != null ? 'estimated' : 'unknown',
    createdAt: now,
    updatedAt: now
  }));

  if (items.length === 0) return { items: [], reminderCount: 0 };

  addConsumables(loadConsumables(), items);
  const plans = items.flatMap((item) => planConsumableReminders(item));
  addReminders(loadReminders(), plans.map(createReminder));

  return { items, reminderCount: plans.length };
}