/**
 * Qingshe Consumable Reality Storage Layer
 *
 * 唯一 Storage Owner：qingshe_consumables
 *
 * 职责：
 * - 安全读取 / 持久化 ConsumableItem[]
 * - 添加 / 更新 / 完成 Consumable
 * - 按 ID 查询
 *
 * 严禁：
 * - 在 page / component / AI route 直接 localStorage.setItem('qingshe_consumables', ...)
 * - 修改 qingshe_consumables 的 JSON shape 而不兼容旧数据
 *
 * 解析失败一律返回 []，禁止 any。
 */

import type { ConsumableItem } from '@/lib/types/consumable';

const STORAGE_KEY = 'qingshe_consumables';

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

export function loadConsumables(): ConsumableItem[] {
  if (!isBrowser()) return [];
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 兜底：每条至少带 id/name/status/createdAt/updatedAt
    return parsed.filter(
      (item): item is ConsumableItem =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as ConsumableItem).id === 'string' &&
        typeof (item as ConsumableItem).name === 'string'
    );
  } catch {
    return [];
  }
}

export function saveConsumables(items: ConsumableItem[]): ConsumableItem[] {
  if (isBrowser()) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  }
  return items;
}

export interface CreateConsumableInput {
  name: string;
  quantity?: number | string;
  unit?: string;
  location?: string;
  purchasedAt?: string;
  estimatedRunOutDays?: number;
  checkIntervalDays?: number;
  category?: string;
  status?: ConsumableItem['status'];
}

/**
 * 工厂函数：构建一个完整的 ConsumableItem。
 * 不写 storage；调用方决定是否持久化。
 */
export function createConsumable(input: CreateConsumableInput): ConsumableItem {
  const now = new Date().toISOString();
  const status: ConsumableItem['status'] =
    input.status ?? (input.estimatedRunOutDays != null ? 'estimated' : 'unknown');
  return {
    id: `consumable_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: input.name.trim(),
    ...(input.quantity != null ? { quantity: input.quantity } : {}),
    ...(input.unit ? { unit: input.unit } : {}),
    ...(input.location ? { location: input.location } : {}),
    ...(input.purchasedAt ? { purchasedAt: input.purchasedAt } : {}),
    ...(input.estimatedRunOutDays != null
      ? { estimatedRunOutDays: input.estimatedRunOutDays }
      : {}),
    ...(input.checkIntervalDays != null
      ? { checkIntervalDays: input.checkIntervalDays }
      : {}),
    ...(input.category ? { category: input.category } : {}),
    status,
    createdAt: now,
    updatedAt: now
  };
}

export function addConsumable(
  items: ConsumableItem[],
  item: ConsumableItem
): ConsumableItem[] {
  const next = [item, ...items];
  return saveConsumables(next);
}

/**
 * 一次性添加多条 Consumable（用于 AI Confirmation 后批量写入）。
 */
export function addConsumables(
  items: ConsumableItem[],
  newItems: ConsumableItem[]
): ConsumableItem[] {
  if (newItems.length === 0) return items;
  const next = [...newItems, ...items];
  return saveConsumables(next);
}

export function updateConsumable(
  items: ConsumableItem[],
  item: ConsumableItem
): ConsumableItem[] {
  const next = items.map((existing) =>
    existing.id === item.id
      ? { ...item, updatedAt: new Date().toISOString() }
      : existing
  );
  return saveConsumables(next);
}

export function deleteConsumable(items: ConsumableItem[], id: string): ConsumableItem[] {
  const next = items.filter((item) => item.id !== id);
  return saveConsumables(next);
}

export function markConsumableFinished(
  items: ConsumableItem[],
  id: string
): ConsumableItem[] {
  const next = items.map((item) =>
    item.id === id
      ? { ...item, status: 'finished' as const, updatedAt: new Date().toISOString() }
      : item
  );
  return saveConsumables(next);
}

export function getConsumableById(
  items: ConsumableItem[],
  id: string
): ConsumableItem | undefined {
  return items.find((item) => item.id === id);
}