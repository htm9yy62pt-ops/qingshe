/**
 * Consumable → Reminder 的唯一映射规则（纯函数，不读写 storage）
 *
 * 为什么单独成模块：
 * 登记消耗品时如果只写 qingshe_consumables，它就是一条静态记录，永远不会
 * 「临近耗尽提醒你」。确认卡片写入消耗品的同时必须建立提醒，
 * 而状态回写（「还有3天用完」）又必须按同一套规则重算 —— 两处共用一份规则，
 * 规则才不会漂移。
 */

import type { ConsumableItem } from '@/lib/types/consumable';
import type { Reminder } from '@/lib/types/reminder';
import { createReminder } from './reminders';
import type { CreateReminderInput } from './reminders';
import {
  computeNextRealityCheckDate,
  computeReplenishmentReminderDate
} from './reminder-engine';

/** 用户既没说多久用完、也没说多久确认一次时的兜底节奏 */
export const DEFAULT_CHECK_INTERVAL_DAYS = 14;

/**
 * 为一个消耗品规划提醒。
 *
 * - 已知预计用完天数 → replenishment（提前 PURCHASE_LEAD_DAYS 天）
 *   已进补货窗口的不建未来提醒，交给 /consumables 的紧急卡片即时提示。
 * - 无论是否知道余量 → reality_check 兜底，定期回访「实际用完了吗」。
 */
export function planConsumableReminders(
  item: ConsumableItem,
  today = new Date()
): CreateReminderInput[] {
  const intervalDays = item.checkIntervalDays ?? DEFAULT_CHECK_INTERVAL_DAYS;
  const plan: CreateReminderInput[] = [];

  if (item.estimatedRunOutDays != null) {
    const replenishAt = computeReplenishmentReminderDate(
      item.estimatedRunOutDays,
      today
    );
    if (replenishAt) {
      plan.push({
        title: `该补货${item.name}了`,
        type: 'replenishment',
        remindAt: replenishAt,
        nextTriggerAt: replenishAt,
        resourceType: 'consumable',
        resourceId: item.id,
        action: 'replenish'
      });
    }
  }

  plan.push({
    title: `确认${item.name}的使用情况`,
    type: 'reality_check',
    intervalDays,
    nextTriggerAt: computeNextRealityCheckDate(intervalDays, today),
    resourceType: 'consumable',
    resourceId: item.id,
    action: 'check_consumption'
  });

  return plan;
}

/**
 * 按最新事实重算某个消耗品的提醒。
 *
 * 只替换该消耗品仍为 active 的提醒：用户已 completed / cancelled 的历史不动，
 * 否则一次状态回写会把处理过的提醒复活。
 */
export function rescheduleConsumableReminders(
  item: ConsumableItem,
  reminders: Reminder[],
  today = new Date()
): Reminder[] {
  const kept = reminders.filter(
    (r) =>
      !(
        r.resourceType === 'consumable' &&
        r.resourceId === item.id &&
        r.status === 'active'
      )
  );
  const fresh = planConsumableReminders(item, today).map(createReminder);
  return [...fresh, ...kept];
}

/**
 * 消耗品已用完：撤掉它所有未完成的提醒。
 * 不撤就会在补货提醒到点时，追问一个已经空掉的东西。
 */
export function silenceConsumableReminders(
  itemId: string,
  reminders: Reminder[]
): Reminder[] {
  const now = new Date().toISOString();
  return reminders.map((r) =>
    r.resourceType === 'consumable' && r.resourceId === itemId && r.status === 'active'
      ? { ...r, status: 'cancelled' as const, updatedAt: now }
      : r
  );
}