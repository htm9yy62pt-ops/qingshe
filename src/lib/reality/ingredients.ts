import { InventoryIngredient } from '@/lib/types/ingredient';
import { ConsumedIngredient } from '@/lib/types/execution-result';
import { updateInventory } from './inventory-update';

const STORAGE_KEY = 'qingshe_ingredients';

/**
 * 统一的冰箱食材 Reality Storage Layer。
 * 单一职责：qingshe_ingredients 的安全读取与持久化。
 *
 * 不修改现有 localStorage 数据格式（保持原始 JSON 形状）。
 * 不删除、不迁移旧数据。
 */
export function loadIngredients(): InventoryIngredient[] {
  if (typeof window === 'undefined') return [];
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as InventoryIngredient[];
  } catch {
    return [];
  }
}

export function saveIngredients(ingredients: InventoryIngredient[]): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ingredients));
}

/**
 * 制作消耗的落库入口：先现读当前库存，再按 inventory-update 的扣减规则写回。
 *
 * 「先读后写」是这条链的关键：菜谱弹窗手里那份列表只是展示快照，拿它当写回基线，
 * 会把快照之后新增或入库的食材整包覆盖掉。库存的唯一真相仍是 localStorage 里那份，
 * 扣减规则仍归 inventory-update 那一份纯函数，这里不另写一套。
 *
 * @param consumedIngredients 弹窗确认过的消耗项（带 inventoryIngredientId / actualQuantity）
 * @returns 落库后的完整库存，供调用方把自己的展示快照对齐到最新
 */
export function consumeIngredients(
  consumedIngredients: ConsumedIngredient[]
): InventoryIngredient[] {
  const nextIngredients = updateInventory(loadIngredients(), consumedIngredients);
  saveIngredients(nextIngredients);
  return nextIngredients;
}

/**
 * 「确认加入冰箱」的唯一落库入口：把已经摆在确认卡上的食材记录追加进库存。
 *
 * 聊天里的多行确认卡和 onboarding 里的「建立我的生活」共用这一个形状转换 + 这一句写盘，
 * 字段默认值（1 / 其他 / 冷藏 / 今天）由这里统一兜底，调用方不必各写一份。
 *
 * 先现读后写：确认卡在屏幕上停留期间，别的入口添进冰箱的食材不能被快照覆盖掉。
 * 入参刻意松类型（只要求 name）：草稿、API 载荷、手动表单三种来源都直接兼容。
 */
export function commitIngredients(records: readonly Record<string, unknown>[]): {
  items: InventoryIngredient[];
  added: number;
} {
  // 名称是最低要求：没名字的半截记录整条不进冰箱，也不占 id
  const rows = records.filter(record => String(record.name ?? '').trim());
  if (rows.length === 0) return { items: loadIngredients(), added: 0 };

  const stamp = Date.now();
  const today = new Date().toISOString().split('T')[0];
  const additions: InventoryIngredient[] = rows.map((row, index) => ({
    id: `ingredient_${stamp}_${index}`,
    name: String(row.name ?? ''),
    quantity: String(row.quantity || '1'),
    unit: String(row.unit || ''),
    category: String(row.category || '其他'),
    purchaseDate: String(row.purchaseDate ?? ''),
    expiryDate: String(row.expiryDate || ''),
    storageLocation: String(row.storageLocation || '冷藏'),
    createdAt: today,
  }));

  const items = [...loadIngredients(), ...additions];
  saveIngredients(items);
  return { items, added: additions.length };
}