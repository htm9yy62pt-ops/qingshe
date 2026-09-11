import {
  ShoppingList,
  ShoppingListItem,
  resolveItemSource
} from '@/lib/types/shopping-list';

const STORAGE_KEY = 'qingshe_shopping_lists';

/**
 * 统一采购清单 Reality Storage Layer。
 *
 * 职责单一：qingshe_shopping_lists 的安全读取与持久化。
 *
 * 兼容：
 * - 旧字段 sourceType = 'recipe' | 'manual' 仍可读取。
 * - 新字段 source = 'manual' | 'recipe' | 'ai' 同时支持。
 * - 不做任何数据迁移，不删除任何旧字段。
 */

export function getShoppingLists(): ShoppingList[] {
  if (typeof window === 'undefined') return [];
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ShoppingList[];
  } catch {
    return [];
  }
}

export function saveShoppingLists(lists: ShoppingList[]): ShoppingList[] {
  if (typeof window !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(lists));
  }
  return lists;
}

export interface CreateShoppingListFromRecipeInput {
  id?: string;
  title: string;
  recipeId?: string;
  missingNames: string[];
}

export function createShoppingListFromRecipe({
  id,
  title,
  recipeId,
  missingNames
}: CreateShoppingListFromRecipeInput): ShoppingList {
  const now = new Date().toISOString();
  return {
    id: id ?? `shopping_list_${Date.now()}`,
    title,
    recipeId,
    items: missingNames.map((name) => ({
      id: `shopping_item_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      status: 'pending',
      sourceType: 'recipe',
      source: 'recipe',
      recipeId,
      createdAt: now
    })),
    createdAt: now,
    updatedAt: now
  };
}

export function findActiveShoppingListByRecipeId(
  lists: ShoppingList[],
  recipeId: string | undefined
): ShoppingList | undefined {
  if (!recipeId) return undefined;
  return lists.find(
    (list) =>
      list.recipeId === recipeId &&
      list.items.some((item) => item.status === 'pending')
  );
}

/**
 * 获取一个"通用 manual"采购清单（用于 Manual Add / AI Task）。
 *
 * 规则：
 * - 第一个 pending 且非 recipe 来源的清单即为通用 manual 清单。
 * - 若不存在则新建一个，标题为「手动采购」。
 */
export function getOrCreateManualShoppingList(lists: ShoppingList[]): {
  lists: ShoppingList[];
  list: ShoppingList;
  created: boolean;
} {
  const existing = lists.find((list) => {
    if (list.recipeId) return false;
    return list.items.some((item) => item.status === 'pending');
  });
  if (existing) {
    return { lists, list: existing, created: false };
  }

  const now = new Date().toISOString();
  const newList: ShoppingList = {
    id: `shopping_list_manual_${Date.now()}`,
    title: '手动采购',
    items: [],
    createdAt: now,
    updatedAt: now
  };
  const nextLists = [newList, ...lists];
  return { lists: nextLists, list: newList, created: true };
}

export interface AddShoppingItemDraft {
  name: string;
  quantity?: number | string;
  unit?: string;
  category?: string;
  budget?: number;
  neededBy?: string;
  remindAt?: string;
  notes?: string;
}

export interface AddShoppingItemsInput {
  /**
   * 不传则创建/复用通用 manual 清单。
   * 显式传入 shoppingListId 时直接追加到该清单。
   */
  shoppingListId?: string;
  items: AddShoppingItemDraft[];
  /**
   * 来源标签。
   * - 'manual'：用户手动添加
   * - 'ai'：AI Task 添加
   * - 'recipe'：保留，理论上不会通过此接口
   */
  source: 'manual' | 'ai';
}

export interface AddShoppingItemsResult {
  lists: ShoppingList[];
  shoppingList: ShoppingList;
  addedItems: ShoppingListItem[];
}

/**
 * 把多个 item 加入采购清单。
 *
 * 流程：
 * 1. 找到目标清单（显式 id 或复用/创建 manual 清单）。
 * 2. 用本次的 source 写入每条 item。
 * 3. 持久化。
 *
 * 注意：永远不直接写 localStorage；调用方应使用返回的 lists。
 */
export function addItemsToShoppingList(
  lists: ShoppingList[],
  input: AddShoppingItemsInput
): AddShoppingItemsResult {
  const now = new Date().toISOString();

  let target = lists.find((l) => l.id === input.shoppingListId);
  let created = false;
  let workingLists = lists;

  if (!target) {
    // 复用 / 创建 manual 清单
    const manual = getOrCreateManualShoppingList(workingLists);
    workingLists = manual.lists;
    target = manual.list;
    created = manual.created;
  }

  const added: ShoppingListItem[] = input.items.map((draft, idx) => ({
    id: `shopping_item_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 8)}`,
    name: draft.name.trim(),
    quantity: draft.quantity,
    unit: draft.unit?.trim() || undefined,
    category: draft.category?.trim() || undefined,
    budget: draft.budget,
    neededBy: draft.neededBy?.trim() || undefined,
    remindAt: draft.remindAt?.trim() || undefined,
    notes: draft.notes?.trim() || undefined,
    status: 'pending',
    source: input.source,
    sourceType: input.source === 'manual' ? 'manual' : 'recipe',
    createdAt: now
  }));

  const nextTarget: ShoppingList = {
    ...target,
    items: [...target.items, ...added],
    updatedAt: now,
    completedAt:
      target.items.length + added.length === 0
        ? target.completedAt
        : undefined
  };

  const nextLists = workingLists.map((l) =>
    l.id === nextTarget.id ? nextTarget : l
  );

  const persisted = saveShoppingLists(nextLists);

  return {
    lists: persisted,
    shoppingList: nextTarget,
    addedItems: added
  };
}

export function toggleShoppingItem(
  lists: ShoppingList[],
  listId: string,
  itemId: string
): ShoppingList[] {
  const nextLists = lists.map((list) => {
    if (list.id !== listId) return list;

    const nextItems = list.items.map((item) => {
      if (item.id !== itemId) return item;
      const nextStatus: ShoppingListItem['status'] =
        item.status === 'purchased' ? 'pending' : 'purchased';
      return { ...item, status: nextStatus };
    });

    const allFinal = nextItems.every(
      (item) => item.status === 'purchased' || item.status === 'cancelled'
    );

    return {
      ...list,
      items: nextItems,
      completedAt: allFinal ? new Date().toISOString() : undefined,
      updatedAt: new Date().toISOString()
    };
  });

  return saveShoppingLists(nextLists);
}

export function cancelShoppingItem(
  lists: ShoppingList[],
  listId: string,
  itemId: string
): ShoppingList[] {
  const nextLists = lists.map((list) => {
    if (list.id !== listId) return list;

    const nextItems = list.items.map((item) =>
      item.id === itemId ? { ...item, status: 'cancelled' as const } : item
    );

    const allFinal = nextItems.every(
      (item) => item.status === 'purchased' || item.status === 'cancelled'
    );

    return {
      ...list,
      items: nextItems,
      completedAt: allFinal ? new Date().toISOString() : undefined,
      updatedAt: new Date().toISOString()
    };
  });

  return saveShoppingLists(nextLists);
}

export function removeShoppingItem(
  lists: ShoppingList[],
  listId: string,
  itemId: string
): ShoppingList[] {
  const nextLists = lists
    .map((list) => {
      if (list.id !== listId) return list;
      const nextItems = list.items.filter((item) => item.id !== itemId);
      const allFinal = nextItems.every(
        (item) => item.status === 'purchased' || item.status === 'cancelled'
      );
      return {
        ...list,
        items: nextItems,
        completedAt: nextItems.length === 0 || allFinal ? new Date().toISOString() : undefined,
        updatedAt: new Date().toISOString()
      };
    })
    .filter((list) => list.items.length > 0);

  return saveShoppingLists(nextLists);
}

export function addShoppingList(lists: ShoppingList[], list: ShoppingList): ShoppingList[] {
  const nextLists = [list, ...lists];
  return saveShoppingLists(nextLists);
}

/**
 * 标记某条 item 已确认入库（P0-B 回程幂等锚点）。
 * 只写 restockedAt 时间戳，不碰任何其它状态，toggle 语义不受影响。
 */
export function markShoppingItemRestocked(
  lists: ShoppingList[],
  listId: string,
  itemId: string
): ShoppingList[] {
  const now = new Date().toISOString();
  const nextLists = lists.map((list) =>
    list.id !== listId
      ? list
      : {
          ...list,
          items: list.items.map((item) =>
            item.id === itemId ? { ...item, restockedAt: now } : item
          ),
          updatedAt: now
        }
  );
  return saveShoppingLists(nextLists);
}

export interface RestockTarget {
  listId: string;
  itemId: string;
}

/**
 * P1-3 批量回程：一次确认把多条 item 标记为已购买 + 已入库。
 *
 * 是「勾选购买（toggle）+ 落锚点（markShoppingItemRestocked）」的合并批量形态，
 * 覆盖同一条链路，不是第二套状态机：
 * - status 只做 pending → purchased 的确认方向，不反向；
 * - restockedAt 保留首锚（已有值不覆盖），幂等语义与单件版一致；
 * - 每个受影响 list 单独重算 completedAt，与 toggle/cancel 的口径相同；
 * - 全程只落一次盘。
 */
export function markShoppingItemsRestocked(
  lists: ShoppingList[],
  targets: RestockTarget[]
): ShoppingList[] {
  if (targets.length === 0) return lists;
  const now = new Date().toISOString();
  const targetIds = new Set(targets.map((t) => `${t.listId}:${t.itemId}`));

  const nextLists = lists.map((list) => {
    const touched = list.items.some((item) =>
      targetIds.has(`${list.id}:${item.id}`)
    );
    if (!touched) return list;

    const nextItems = list.items.map((item) =>
      targetIds.has(`${list.id}:${item.id}`)
        ? {
            ...item,
            status: item.status === 'cancelled' ? item.status : ('purchased' as const),
            restockedAt: item.restockedAt ?? now
          }
        : item
    );

    const allFinal = nextItems.every(
      (item) => item.status === 'purchased' || item.status === 'cancelled'
    );

    return {
      ...list,
      items: nextItems,
      completedAt: allFinal ? list.completedAt ?? now : undefined,
      updatedAt: now
    };
  });

  return saveShoppingLists(nextLists);
}

/**
 * 按 listId 重新计算 list 的最终状态（用于 addItemsToShoppingList 之后）。
 * 暴露为工具函数，主要给未来 dashboard 用。
 */
export function reconcileListStatus(list: ShoppingList): ShoppingList {
  if (list.items.length === 0) return list;
  const allFinal = list.items.every(
    (item) => item.status === 'purchased' || item.status === 'cancelled'
  );
  return {
    ...list,
    completedAt: allFinal ? list.completedAt ?? new Date().toISOString() : undefined
  };
}

/**
 * AI 采购草稿落地的唯一入口。
 *
 * 确认卡片上的按钮和聊天里打的「确认」必须走同一个函数，
 * 否则会出现「点了有清单、打了没清单」这种分叉。
 */
export function commitShoppingDrafts(
  items: AddShoppingItemDraft[]
): ShoppingListItem[] {
  return addItemsToShoppingList(getShoppingLists(), { items, source: 'ai' })
    .addedItems;
}

export { resolveItemSource };