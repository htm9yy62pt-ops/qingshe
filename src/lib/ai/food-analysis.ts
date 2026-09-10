import type { InventoryIngredient } from '@/lib/types/ingredient';

/**
 * 食材分析接口定义
 */

export interface AnalyzedIngredient {
  id: string;
  name: string;
  quantity: string;
  unit: string;
  category: string;
  expiryDate: string;
  storageLocation: string;
  daysUntilExpiry: number | null;
  urgency: 'expired' | 'urgent' | 'normal' | 'unknown';
}

export interface FoodAnalysis {
  availableIngredients: AnalyzedIngredient[];
  urgentIngredients: AnalyzedIngredient[];
  expiredIngredients: AnalyzedIngredient[];
  summary: string;
}

/**
 * 分析食材新鲜度和紧急程度
 *
 * 重要：InventoryIngredient 可能在用户确认吃完后被标记为 status === 'finished'。
 * 此类食材在 Reality Layer 中保留，但不应进入可用库存、临期分类、AI 推荐。
 * 本函数在分析前先过滤 finished 食材。
 */
export function analyzeFoodIngredients(
  ingredients: InventoryIngredient[]
): FoodAnalysis {
  // 过滤掉已吃完的食材：finished 食材不应进入 Food Analysis 任何阶段
  const activeIngredients = ingredients.filter(
    (ingredient) => ingredient.status !== 'finished'
  );

  const analyzedIngredients: AnalyzedIngredient[] = activeIngredients.map((ingredient) => {
    let daysUntilExpiry: number | null = null;
    let urgency: 'expired' | 'urgent' | 'normal' | 'unknown' = 'unknown';
    
    // 计算距离过期天数
    if (ingredient.expiryDate) {
      try {
        const expiryDate = new Date(ingredient.expiryDate);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        expiryDate.setHours(0, 0, 0, 0);
        
        const diffTime = expiryDate.getTime() - today.getTime();
        daysUntilExpiry = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        
        // 根据剩余天数确定紧急程度
        if (daysUntilExpiry < 0) {
          urgency = 'expired';
        } else if (daysUntilExpiry >= 0 && daysUntilExpiry <= 3) {
          urgency = 'urgent';
        } else {
          urgency = 'normal';
        }
      } catch (e) {
        // 如果日期解析失败，保持 unknown 状态
        daysUntilExpiry = null;
        urgency = 'unknown';
      }
    }
    
    return {
      id: ingredient.id,
      name: ingredient.name,
      quantity: ingredient.quantity,
      unit: ingredient.unit,
      category: ingredient.category,
      expiryDate: ingredient.expiryDate,
      storageLocation: ingredient.storageLocation,
      daysUntilExpiry,
      urgency
    };
  });
  
  // 按紧急程度分类
  const expiredIngredients = analyzedIngredients.filter(item => item.urgency === 'expired');
  const availableIngredients = analyzedIngredients.filter(item => 
    item.urgency !== 'expired'  // 所有非过期的食材都是可用的
  );
  const urgentIngredients = availableIngredients  // 从可用食材中筛选出紧急的
    .filter(item => item.urgency === 'urgent')
    .sort((a, b) => (a.daysUntilExpiry || Infinity) - (b.daysUntilExpiry || Infinity)); // 临期越近越靠前
  
  // 生成摘要
  const totalIngredients = analyzedIngredients.length;
  const urgentCount = urgentIngredients.length;
  const expiredCount = expiredIngredients.length;
  
  let summary = `冰箱共有${totalIngredients}种食材`;
  if (urgentCount > 0) {
    summary += `，其中${urgentCount}种临近过期`;
  }
  if (expiredCount > 0) {
    summary += `，${expiredCount}种已过期`;
  }
  
  return {
    availableIngredients,
    urgentIngredients,
    expiredIngredients,
    summary
  };
}