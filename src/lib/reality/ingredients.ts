import {
  InventoryIngredient,
  KitchenStorageLocation,
  KITCHEN_STORAGE_LOCATIONS,
  UNSPECIFIED_STORAGE_LABEL,
  normalizeStorageLocation
} from '@/lib/types/ingredient';
import { ConsumedIngredient } from '@/lib/types/execution-result';
import { updateInventory } from './inventory-update';

const STORAGE_KEY = 'qingshe_ingredients';

/**
 * 统一的厨房资源 Reality Storage Layer。
 * 单一职责：qingshe_ingredients 的安全读取、持久化，以及「已存值怎么读给人看」。
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
 * 「确认加入厨房」的唯一落库入口：把已经摆在确认卡上的食材记录追加进库存。
 *
 * 聊天里的多行确认卡、onboarding 里的「建立我的生活」、手动表单共用这一个形状转换 +
 * 这一句写盘，字段默认值（数量 1 / 类目 其他 / 今天）由这里统一兜底，调用方不必各写一份。
 *
 * **储存位置是唯一不许兜底默认值的字段**：用户没说位置就是空，
 * 空值由 `describeStorageLocation` 显示成「未指定」。曾经这里写的是 `|| '冷藏'`，
 * 于是「我有鸡蛋」会被系统替用户决定放冷藏 —— 那是把猜测写进现实数据。
 * 位置原值原样入库，写入端不做校验也不改写：认不出的历史值只是读的时候归进「其他」，
 * 字段本身留在记录里，等用户自己去改。
 *
 * 先现读后写：确认卡在屏幕上停留期间，别的入口添进厨房的食材不能被快照覆盖掉。
 * 入参刻意松类型（只要求 name）：草稿、API 载荷、手动表单三种来源都直接兼容。
 */
export function commitIngredients(records: readonly Record<string, unknown>[]): {
  items: InventoryIngredient[];
  added: number;
} {
  // 名称是最低要求：没名字的半截记录整条不进厨房，也不占 id
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
    storageLocation: String(row.storageLocation ?? '').trim(),
    createdAt: today,
  }));

  const items = [...loadIngredients(), ...additions];
  saveIngredients(items);
  return { items, added: additions.length };
}

export interface KitchenStorageGroup {
  /** null = 未指定（空值与旧数据缺字段）；只用于 React key 与归组，不参与落库 */
  location: KitchenStorageLocation | '其他' | null;
  label: string;
  items: InventoryIngredient[];
}

/**
 * 我的厨房的分组视图：冷藏 / 冷冻 / 橱柜 / 常温 / 其他 / 未指定，只返回有数据的组。
 *
 * 纯函数、只读：分组是「同一份 storageLocation 的另一种读法」，不是空间模型 ——
 * 没有货架、没有层级、没有拖拽，库存的 CRUD 与字段形状一律不变。
 * 位置的识别与文案住在 `@/lib/types/ingredient`（`normalizeStorageLocation` /
 * `describeStorageLocation`），这里只负责把行归到组里。
 * 组内保持库存原顺序（后入库的在后），与列表页一贯的时间顺序一致。
 */
export function groupIngredientsByStorage(
  items: readonly InventoryIngredient[]
): KitchenStorageGroup[] {
  const buckets = new Map<KitchenStorageGroup['location'], InventoryIngredient[]>();
  for (const item of items) {
    const known = normalizeStorageLocation(item.storageLocation);
    const key = known ?? (String(item.storageLocation ?? '').trim() ? '其他' : null);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }

  // '其他' 既是被支持的位置、也是认不出时的归组，只此一个桶；顺序表里不能重复列它
  const order: KitchenStorageGroup['location'][] = [...KITCHEN_STORAGE_LOCATIONS, null];
  return order
    .filter((location) => buckets.has(location))
    .map((location) => ({
      location,
      label: location === null ? UNSPECIFIED_STORAGE_LABEL : String(location),
      items: buckets.get(location) as InventoryIngredient[]
    }));
}