/**
 * Qingshe Reminder Engine — 纯业务逻辑层
 *
 * 职责：
 * - 计算哪些 reminder 已到期（getDueReminders）
 * - 根据 reminder + consumable 生成对应 action（processConsumableReminder）
 * - 计算消费品状态（getConsumableKnowledgeStatus）
 *
 * 禁止：
 * - 依赖 React / DOM
 * - 直接访问 localStorage
 * - 修改 Reminder/Consumable 数据结构
 */

import type { Reminder } from '@/lib/types/reminder';
import type { ConsumableItem } from '@/lib/types/consumable';

export const PURCHASE_LEAD_DAYS = 5;

export type KnowledgeStatus = 'unknown_runout' | 'estimated_runout' | 'urgent_replenishment';

/**
 * 基于现有 ConsumableItem 字段计算知识状态（纯函数，无副作用）。
 * 兼容现有结构：estimatedRunOutDays / checkIntervalDays / status。
 */
export function getConsumableKnowledgeStatus(item: ConsumableItem): KnowledgeStatus {
  if (item.estimatedRunOutDays != null) {
    if (item.estimatedRunOutDays <= PURCHASE_LEAD_DAYS) {
      return 'urgent_replenishment';
    }
    return 'estimated_runout';
  }
  // 没有 estimatedRunOutDays 时：看检查间隔，或默认未知
  if (item.checkIntervalDays != null || item.status === 'unknown') {
    return 'unknown_runout';
  }
  return 'unknown_runout';
}

/**
 * 判断 reminder 是否已到期（nextTriggerAt <= now）。
 */
export function getDueReminders(reminders: Reminder[], now = new Date()): Reminder[] {
  const nowIso = now.toISOString();
  return reminders.filter((r) => {
    if (r.status !== 'active') return false;
    if (!r.nextTriggerAt && !r.remindAt) return false;
    const trigger = r.nextTriggerAt || r.remindAt;
    return trigger ? trigger <= nowIso : false;
  });
}

export interface RemindAction {
  reminder: Reminder;
  type: 'reality_check' | 'replenishment' | 'urgent_reminder';
  title: string;
  message: string;
  options?: { label: string; value: string }[];
}

/**
 * 处理消耗品提醒：根据 reminder.type 生成对应交互动作。
 *
 * 1. reality_check → 询问真实状态
 * 2. replenishment → 提醒购买（按 remainingDays 计算文案）
 * 3. urgent_reminder → 紧急提示（剩余 <=5 天，无需等待）
 */
export function processConsumableReminder(
  reminder: Reminder,
  consumable?: ConsumableItem
): RemindAction {
  const remainingDays = consumable?.estimatedRunOutDays;

  if (reminder.type === 'reality_check') {
    return {
      reminder,
      type: 'reality_check',
      title: `你的${consumable?.name ?? '消耗品'}还有多少呀？`,
      message: '你现在知道大概多久会用完了吗？',
      options: [
        { label: '还不知道', value: 'unknown' },
        { label: '知道了', value: 'known' }
      ]
    };
  }

  if (reminder.type === 'replenishment') {
    // 判断是否已到紧急状态
    if (remainingDays != null && remainingDays <= PURCHASE_LEAD_DAYS) {
      return {
        reminder,
        type: 'urgent_reminder',
        title: `⚠️ 你的${consumable?.name ?? '消耗品'}快用完了`,
        message: `预计还剩 ${remainingDays} 天。记得及时补充哦。`,
        options: [
          { label: '查看购买建议', value: 'replenish' }
        ]
      };
    }
    return {
      reminder,
      type: 'replenishment',
      title: `该买新的${consumable?.name ?? '消耗品'}啦`,
      message: `距离预计用完还有 ${remainingDays ?? '5'} 天。`,
      options: [
        { label: '查看推荐购买方式', value: 'replenish' }
      ]
    };
  }

  // 默认（普通 / 其他）
  return {
    reminder,
    type: 'reality_check',
    title: consumable?.name ?? '消耗品提醒',
    message: '请检查使用情况。'
  };
}

/**
 * 计算补货提醒时间：
 * estimatedRunOutDays - PURCHASE_LEAD_DAYS = remindAt（相对于 today）。
 * 如果 <=0，直接返回紧急状态提示（由 UI 层处理）。
 */
export function computeReplenishmentReminderDate(
  estimatedRunOutDays: number,
  today = new Date()
): string | null {
  if (estimatedRunOutDays <= PURCHASE_LEAD_DAYS) return null; // 紧急，不建未来提醒
  const d = new Date(today);
  d.setDate(d.getDate() + (estimatedRunOutDays - PURCHASE_LEAD_DAYS));
  return d.toISOString();
}

/**
 * 计算下次 reality_check 提醒时间：
 * today + checkIntervalDays
 */
export function computeNextRealityCheckDate(
  checkIntervalDays: number,
  today = new Date()
): string {
  const d = new Date(today);
  d.setDate(d.getDate() + checkIntervalDays);
  return d.toISOString();
}