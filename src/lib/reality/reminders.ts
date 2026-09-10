/**
 * Qingshe Reminder Reality Storage Layer
 *
 * 唯一 Storage Owner：qingshe_reminders
 *
 * 职责：
 * - 安全读取 / 持久化 Reminder[]
 * - addReminder / updateReminder / deleteReminder
 * - getActiveReminders / getRemindersByResource
 *
 * 严禁：
 * - 在 page / component / AI route 直接 localStorage.setItem('qingshe_reminders', ...)
 * - 修改 JSON shape 而不兼容旧数据
 */

import type {
  Reminder,
  ReminderType,
  ReminderStatus,
  ReminderResourceType
} from '@/lib/types/reminder';

const STORAGE_KEY = 'qingshe_reminders';

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

export function loadReminders(): Reminder[] {
  if (!isBrowser()) return [];
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is Reminder =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Reminder).id === 'string' &&
        typeof (item as Reminder).title === 'string' &&
        typeof (item as Reminder).type === 'string'
    );
  } catch {
    return [];
  }
}

export function saveReminders(items: Reminder[]): Reminder[] {
  if (isBrowser()) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  }
  return items;
}

export interface CreateReminderInput {
  title: string;
  type: ReminderType;
  status?: ReminderStatus;
  remindAt?: string;
  intervalDays?: number;
  nextTriggerAt?: string;
  resourceType?: ReminderResourceType;
  resourceId?: string;
  action?: string;
}

/**
 * 工厂函数：构造完整 Reminder。
 * 不写 storage；调用方决定是否持久化。
 */
export function createReminder(input: CreateReminderInput): Reminder {
  const now = new Date().toISOString();
  return {
    id: `reminder_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: input.title,
    type: input.type,
    status: input.status ?? 'active',
    ...(input.remindAt ? { remindAt: input.remindAt } : {}),
    ...(input.intervalDays != null ? { intervalDays: input.intervalDays } : {}),
    ...(input.nextTriggerAt ? { nextTriggerAt: input.nextTriggerAt } : {}),
    ...(input.resourceType ? { resourceType: input.resourceType } : {}),
    ...(input.resourceId ? { resourceId: input.resourceId } : {}),
    ...(input.action ? { action: input.action } : {}),
    createdAt: now,
    updatedAt: now
  };
}

export function addReminder(
  items: Reminder[],
  reminder: Reminder
): Reminder[] {
  const next = [reminder, ...items];
  return saveReminders(next);
}

/**
 * 一次性添加多条 Reminder（用于 Consumable Confirmation 后批量写入）。
 */
export function addReminders(
  items: Reminder[],
  newReminders: Reminder[]
): Reminder[] {
  if (newReminders.length === 0) return items;
  const next = [...newReminders, ...items];
  return saveReminders(next);
}

export function updateReminder(
  items: Reminder[],
  reminder: Reminder
): Reminder[] {
  const next = items.map((existing) =>
    existing.id === reminder.id
      ? { ...reminder, updatedAt: new Date().toISOString() }
      : existing
  );
  return saveReminders(next);
}

export function deleteReminder(items: Reminder[], id: string): Reminder[] {
  const next = items.filter((item) => item.id !== id);
  return saveReminders(next);
}

export function getActiveReminders(items: Reminder[]): Reminder[] {
  return items.filter((item) => item.status === 'active');
}

export function getRemindersByResource(
  items: Reminder[],
  resourceType: ReminderResourceType,
  resourceId: string
): Reminder[] {
  return items.filter(
    (item) => item.resourceType === resourceType && item.resourceId === resourceId
  );
}

/**
 * 工具函数：基于 ISO 日期 + 天数，生成新的 ISO 日期。
 */
export function addDaysIso(baseIso: string, days: number): string {
  const d = new Date(baseIso);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

/**
 * 工具函数：今天 + N 天（用于默认 now）。
 */
export function nowPlusDays(days: number): string {
  return addDaysIso(new Date().toISOString(), days);
}