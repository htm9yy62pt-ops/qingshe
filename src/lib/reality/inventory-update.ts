import { InventoryIngredient } from '@/lib/types/ingredient';
import { ConsumedIngredient } from '@/lib/types/execution-result';

/**
 * 根据确认消耗的食材更新冰箱库存。
 * 纯函数：返回新的 ingredients 数组，不修改外部状态。
 */
export function updateInventory(
  ingredients: InventoryIngredient[],
  consumedIngredients: ConsumedIngredient[]
): InventoryIngredient[] {
  // 建立 id -> index 映射，确保每个食材只被更新一次
  const indexMap = new Map<string, number>();
  const nextIngredients = ingredients.map((item, index) => {
    indexMap.set(item.id, index);
    return { ...item };
  });

  for (const consumed of consumedIngredients) {
    if (!consumed.confirmed || !consumed.inventoryIngredientId) continue;
    if (consumed.actualQuantity == null || consumed.actualQuantity <= 0) continue;

    const index = indexMap.get(consumed.inventoryIngredientId);
    if (index === undefined) continue;

    const item = nextIngredients[index];
    const currentQty = parseFloat(item.quantity);

    // 如果库存数量无法解析为数字，则无法自动扣减，跳过
    if (Number.isNaN(currentQty)) continue;

    const nextQty = Math.max(0, currentQty - consumed.actualQuantity);

    // Ingredient 数据结构已有可选 status 字段：
    // 数量扣减至 0 时保留记录，并标记为已吃完，不删除数据。
    nextIngredients[index] = {
      ...item,
      quantity: String(nextQty),
      ...(nextQty === 0 ? { status: 'finished' as const } : {})
    };
  }

  return nextIngredients;
}