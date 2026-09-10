/**
 * Consumable 状态回写编排（唯一的写入协调者）
 *
 * 职责：把「用户陈述的事实」同时落到 qingshe_consumables 和 qingshe_reminders。
 * 两者必须一起动 —— 只改消耗品不改提醒，补货提醒就会停在旧日期上；
 * 这段编排放在页面里会变成无法离线验证的私有逻辑，因此独立成模块。
 *
 * 输入类型刻意本地声明：reality 层不依赖 ai 层，结构兼容即可。
 */

import { loadConsumables, updateConsumable } from './consumables';
import { loadReminders, saveReminders } from './reminders';
import {
  rescheduleConsumableReminders,
  silenceConsumableReminders
} from './consumable-reminders';
import type { ConsumableItem } from '@/lib/types/consumable';

export interface ConsumableStatusPatch {
  consumableId: string;
  urgency: 'normal' | 'soon' | 'urgent';
  markFinished: boolean;
  remainingQuantity?: number;
  estimatedRunOutDays?: number;
}

/** 返回真正被改写的消耗品，供调用方做 UI 反馈 */
export function applyConsumableStatusUpdates(
  patches: ConsumableStatusPatch[]
): ConsumableItem[] {
  if (patches.length === 0) return [];

  let items = loadConsumables();
  let reminders = loadReminders();
  const applied: ConsumableItem[] = [];

  for (const patch of patches) {
    const target = items.find((item) => item.id === patch.consumableId);
    if (!target) continue;

    const next: ConsumableItem = {
      ...target,
      ...(patch.remainingQuantity != null ? { quantity: patch.remainingQuantity } : {}),
      ...(patch.estimatedRunOutDays != null
        ? { estimatedRunOutDays: patch.estimatedRunOutDays }
        : {}),
      status: nextStatusOf(target, patch)
    };

    items = updateConsumable(items, next);
    reminders = patch.markFinished
      ? silenceConsumableReminders(next.id, reminders)
      : rescheduleConsumableReminders(next, reminders);
    applied.push(next);
  }

  saveReminders(reminders);
  return applied;
}

/**
 * 状态机：finished > running_low > estimated > learning，只升不降回 unknown。
 * 「还剩两瓶」这类纯数量陈述不该把已给出预计时间的条目降级。
 */
function nextStatusOf(
  target: ConsumableItem,
  patch: ConsumableStatusPatch
): ConsumableItem['status'] {
  if (patch.markFinished) return 'finished';
  if (patch.urgency === 'urgent' || patch.urgency === 'soon') return 'running_low';
  if (patch.estimatedRunOutDays != null) return 'estimated';
  return target.status === 'estimated' ? 'estimated' : 'learning';
}