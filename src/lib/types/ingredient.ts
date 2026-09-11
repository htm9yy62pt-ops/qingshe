/**
 * 厨房储存位置（数据契约）。
 *
 * 放在类型层而不是 AI 层，是因为「位置」同时被三处读取：
 * Parser/Router 拿它做自然语言识别，Reality 层拿它做落库与分组，UI 拿它做展示。
 * AI 词表（task-router 的 KITCHEN_REGION_LEXICON）必须与本联合类型同键 ——
 * 词表可以长出「碗柜」「保鲜层」这种别名，别名归一之后的值只能落在这里。
 *
 * 「未指定」故意不是一种位置：它是空值的显示文案（见 UNSPECIFIED_STORAGE_LABEL），
 * 底层永远存 ''（或干脆没有这个字段），谁都不许把「未指定」当真实位置写进现实数据。
 */
export type KitchenStorageLocation = '冷藏' | '冷冻' | '橱柜' | '常温' | '其他';

/** 分组显示顺序：已知的在前，未指定永远垫底 */
export const KITCHEN_STORAGE_LOCATIONS: readonly KitchenStorageLocation[] = [
  '冷藏',
  '冷冻',
  '橱柜',
  '常温',
  '其他'
];

/** 空值（undefined / null / ''）的统一文案；不是可写入的位置值 */
export const UNSPECIFIED_STORAGE_LABEL = '未指定';

export interface InventoryIngredient {
  id: string;
  name: string;
  quantity: string;
  unit: string;
  category: string;
  purchaseDate: string;
  expiryDate: string;
  storageLocation: string;
  createdAt: string;
  /** 当食材被确认吃完且库存扣减至 0 时标记（可选字段，保持向后兼容） */
  status?: 'finished';
}

/**
 * 已存字符串 → 规范位置；空值与认不出的值都返回 undefined（= 未指定）。
 *
 * 认不出的值不强行改写成规范位置，也不报错：历史数据里可能有旧表单留下的字符串，
 * 原则是「不迁移、不篡改、不丢行」。
 */
export function normalizeStorageLocation(value: unknown): KitchenStorageLocation | undefined {
  const raw = String(value ?? '').trim();
  return (KITCHEN_STORAGE_LOCATIONS as readonly string[]).includes(raw)
    ? (raw as KitchenStorageLocation)
    : undefined;
}

/**
 * 储存位置的用户可见文案 —— 全项目只有这一处理解「空值该显示成什么」。
 *
 * 空 / 缺字段 → 「未指定」；有值但不在联合类型里 → 「其他」（原值仍留在记录里，只是归组显示）。
 * 纯函数、无副作用，UI 与 Reality 层共用，不碰 localStorage。
 */
export function describeStorageLocation(value: unknown): string {
  const known = normalizeStorageLocation(value);
  if (known) return known;
  return String(value ?? '').trim() ? '其他' : UNSPECIFIED_STORAGE_LABEL;
}