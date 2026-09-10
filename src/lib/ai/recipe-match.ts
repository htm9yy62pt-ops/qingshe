import type { Recipe, RecipeIngredient } from '@/lib/types/recipe';
import { FoodAnalysis, AnalyzedIngredient } from './food-analysis';

export interface RecipeMatchDetail {
  recipe: Recipe;
  requiredIngredients: string[]; // 菜谱所有必需食材名称
  availableIngredients: string[]; // 用户真实拥有且未过期的食材
  missingIngredients: string[]; // 必需但用户未拥有的食材
  urgentIngredientsUsed: string[]; // 用户拥有且处于 urgent 状态的食材
  normalIngredientsUsed: string[]; // 用户拥有且处于 normal 状态的食材
  unknownIngredientsUsed: string[]; // 用户拥有但状态未知的食材
  matchScore: number; // 综合匹配分数（0-100）
  urgencyBonus: number; // 临期食材加分
  userRecipeBonus: number; // 用户菜谱轻微加分
  reason: string; // 推荐原因摘要
}

interface MatchInput {
  userIngredients: AnalyzedIngredient[];
  officialRecipes: Recipe[];
  userRecipes: Recipe[];
}

/**
 * 规范化食材名称，用于模糊匹配
 * 目前仅做基础处理：去除首尾空格、统一小写
 * 未来可扩展为同义词库（如「西红柿」=「番茄」）
 */
function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * 判断菜谱所需食材是否在用户真实食材中可用
 * 返回匹配到的用户食材（如果存在）
 */
function findAvailableIngredient(
  requiredName: string,
  userIngredients: AnalyzedIngredient[]
): AnalyzedIngredient | undefined {
  const normalizedRequired = normalizeName(requiredName);
  return userIngredients.find(
    (ui) => normalizeName(ui.name) === normalizedRequired
  );
}

/**
 * 计算单个菜谱的匹配详情
 */
function matchRecipe(
  recipe: Recipe,
  userIngredients: AnalyzedIngredient[],
  isUserRecipe: boolean
): RecipeMatchDetail {
  const requiredIngredients = recipe.ingredients
    .filter((i) => i.required)
    .map((i) => i.name);

  const availableIngredients: string[] = [];
  const missingIngredients: string[] = [];
  const urgentIngredientsUsed: string[] = [];
  const normalIngredientsUsed: string[] = [];
  const unknownIngredientsUsed: string[] = [];

  requiredIngredients.forEach((requiredName) => {
    const matched = findAvailableIngredient(requiredName, userIngredients);

    if (matched && matched.urgency !== 'expired') {
      availableIngredients.push(matched.name);

      switch (matched.urgency) {
        case 'urgent':
          urgentIngredientsUsed.push(matched.name);
          break;
        case 'normal':
          normalIngredientsUsed.push(matched.name);
          break;
        case 'unknown':
        default:
          unknownIngredientsUsed.push(matched.name);
          break;
      }
    } else {
      missingIngredients.push(requiredName);
    }
  });

  const totalRequired = requiredIngredients.length || 1;
  const availableCount = availableIngredients.length;
  const matchedRatio = availableCount / totalRequired;

  // 基础分：匹配到的必需食材比例 * 70
  const baseScore = matchedRatio * 70;

  // 临期食材加分：每个临期食材 +10，最高 25
  const urgencyBonus = Math.min(urgentIngredientsUsed.length * 10, 25);

  // 用户菜谱轻微加分：+5，但不足以压过官方菜谱的匹配度
  const userRecipeBonus = isUserRecipe ? 5 : 0;

  const matchScore = Math.min(100, Math.round(baseScore + urgencyBonus + userRecipeBonus));

  // 生成推荐原因
  let reason = '';
  if (urgentIngredientsUsed.length > 0) {
    reason = `包含临期食材：${urgentIngredientsUsed.join('、')}，优先处理可减少浪费。`;
  } else if (availableCount === totalRequired) {
    reason = '所需食材你都有，可以直接做。';
  } else if (matchedRatio >= 0.5) {
    reason = `已有大部分食材，只需要补充${missingIngredients.join('、')}。`;
  } else {
    reason = '你有一部分食材，但还需要采购不少材料。';
  }

  return {
    recipe,
    requiredIngredients,
    availableIngredients,
    missingIngredients,
    urgentIngredientsUsed,
    normalIngredientsUsed,
    unknownIngredientsUsed,
    matchScore,
    urgencyBonus,
    userRecipeBonus,
    reason
  };
}

/**
 * 对所有菜谱进行匹配并排序
 *
 * 排序规则：
 * 1. 使用临期食材数量越多越靠前
 * 2. 综合匹配分数越高越靠前
 * 3. 缺少食材越少越靠前
 * 4. 用户自己的菜谱给予轻微优先级
 */
function sortMatches(matches: RecipeMatchDetail[]): RecipeMatchDetail[] {
  return matches.sort((a, b) => {
    // 1. 临期食材数量降序
    if (b.urgentIngredientsUsed.length !== a.urgentIngredientsUsed.length) {
      return b.urgentIngredientsUsed.length - a.urgentIngredientsUsed.length;
    }

    // 2. 匹配分数降序
    if (b.matchScore !== a.matchScore) {
      return b.matchScore - a.matchScore;
    }

    // 3. 缺少食材数量升序
    if (a.missingIngredients.length !== b.missingIngredients.length) {
      return a.missingIngredients.length - b.missingIngredients.length;
    }

    // 4. 用户菜谱轻微优先
    return b.userRecipeBonus - a.userRecipeBonus;
  });
}

/**
 * 执行菜谱匹配
 *
 * 输入：
 * - userIngredients: 经过 FoodAnalysis 分析后的食材列表（只使用 availableIngredients）
 * - officialRecipes: 轻舍官方菜谱
 * - userRecipes: 用户自己的菜谱
 *
 * 输出：按推荐优先级排序的 RecipeMatchDetail 数组
 *
 * 重要前提：FoodAnalysis 在 analyzeFoodIngredients 阶段已经过滤掉
 * status === 'finished' 的食材，因此本函数无须再重复过滤。
 */
export function matchRecipes(
  foodAnalysis: FoodAnalysis,
  officialRecipes: Recipe[],
  userRecipes: Recipe[]
): RecipeMatchDetail[] {
  // 只使用可用食材（非过期）进行匹配
  const userIngredients = foodAnalysis.availableIngredients;

  const officialMatches = officialRecipes.map((recipe) =>
    matchRecipe(recipe, userIngredients, false)
  );

  const userMatches = userRecipes.map((recipe) =>
    matchRecipe(recipe, userIngredients, true)
  );

  return sortMatches([...officialMatches, ...userMatches]);
}

/**
 * 将 RecipeMatch 结果格式化为 AI Prompt 中可读的文本
 */
export function formatRecipeMatches(matches: RecipeMatchDetail[]): string {
  if (matches.length === 0) {
    return '当前没有可匹配的菜谱。';
  }

  return matches
    .map((match, index) => {
      const lines: string[] = [
        `【候选 ${index + 1}】${match.recipe.title}`,
        `  推荐原因：${match.reason}`,
        `  匹配分数：${match.matchScore}（临期加分 +${match.urgencyBonus}${
          match.userRecipeBonus > 0 ? '，我的菜谱加分 +' + match.userRecipeBonus : ''
        }）`,
        `  已有食材：${match.availableIngredients.join('、') || '无'}`,
        `  缺少/可能需要食材：${match.missingIngredients.join('、') || '无'}`,
        `  临期食材：${match.urgentIngredientsUsed.join('、') || '无'}`,
        `  预计时间：${match.recipe.estimatedTime} 分钟 | 难度：${match.recipe.difficulty}`
      ];
      return lines.join('\n');
    })
    .join('\n\n');
}