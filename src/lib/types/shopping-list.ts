/**
 * ShoppingListItem 数据模型（向后兼容扩展版）。
 *
 * 设计原则：
 * - 旧字段（status: 'pending' | 'purchased' | 'cancelled'、sourceType）保留。
 * - 新增可选字段：quantity（数字）、category、budget、neededBy、remindAt、notes、source。
 * - 旧数据无 source / sourceType 时默认视为 'recipe'，不破坏现有采购清单。
 *
 * 状态语义：
 * - pending：还未购买
 * - purchased：已购入
 * - cancelled：取消（暂不需要）
 *
 * 来源（source / sourceType）规范：
 * - recipe：来自 Recipe Missing Ingredients 流程
 * - manual：用户在 /shopping-list 页面手动添加
 * - ai：来自 AI Task（add_shopping_item）
 */

export type ShoppingListItemStatus = 'pending' | 'purchased' | 'cancelled';

/**
 * 旧字段保留：sourceType 用于兼容 Recipe 流程。
 * 旧代码用 sourceType = 'recipe' | 'manual'。
 */
export type ShoppingListItemSourceType = 'recipe' | 'manual';

/**
 * 新字段：source 是统一来源标记，扩展为 ai。
 * 旧数据没有此字段时视为 'recipe'（向后兼容）。
 */
export type ShoppingListItemSource = 'manual' | 'recipe' | 'ai';

export interface ShoppingListItem {
  id: string;
  name: string;

  // 旧字段：quantity 旧版本可能为 string（来自 Recipe 流程），新版本支持 number。
  // 为了兼容 Recipe 流程，这里保持原样为可选 string | number。
  quantity?: string | number;
  unit?: string;
  category?: string;

  /** 推荐字段：用户预算（仅 manual / ai 来源支持） */
  budget?: number;

  /** 推荐字段：什么时候需要（自由文本，例如 "明天"、"今晚"） */
  neededBy?: string;

  /** 可选：提醒时间（ISO 字符串）。本次不实现提醒系统，仅占位。 */
  remindAt?: string;

  /** 可选：备注 */
  notes?: string;

  status: ShoppingListItemStatus;

  /** 旧字段：来源类型。recipe 流程固定为 'recipe'，旧数据无值时按 'recipe' 兜底。 */
  sourceType?: ShoppingListItemSourceType;

  /** 新字段：统一来源标签。旧数据无值时按 'recipe' 兜底（兼容 Recipe 流程）。 */
  source?: ShoppingListItemSource;

  /** Recipe 流程携带 recipeId，其它来源无此字段。 */
  recipeId?: string;

  /**
   * P0-B 回程幂等标记：该 item 已确认入库（写入 qingshe_ingredients）的时间。
   * 有值即不再对同一 item 弹入库确认卡；取消入库不写此字段（可再次勾选重试）。
   */
  restockedAt?: string;

  createdAt: string;
}

/**
 * 默认 source 推断（向后兼容）：
 * - 显式 source：优先返回
 * - 否则按 sourceType：'manual' → 'manual'，'recipe' → 'recipe'
 * - 否则：'recipe'（兜底）
 */
export function resolveItemSource(item: ShoppingListItem): ShoppingListItemSource {
  if (item.source === 'manual' || item.source === 'recipe' || item.source === 'ai') {
    return item.source;
  }
  if (item.sourceType === 'manual') return 'manual';
  if (item.sourceType === 'recipe') return 'recipe';
  return 'recipe';
}

/**
 * 旧 sourceType 兜底（保持现有 Recipe 流程可用）。
 */
export function resolveItemSourceType(
  item: ShoppingListItem
): ShoppingListItemSourceType {
  if (item.sourceType === 'manual' || item.sourceType === 'recipe') return item.sourceType;
  return resolveItemSource(item) === 'manual' ? 'manual' : 'recipe';
}

export interface ShoppingList {
  id: string;
  title: string;
  recipeId?: string;
  items: ShoppingListItem[];
  completedAt?: string;
  createdAt: string;
  updatedAt?: string;
}