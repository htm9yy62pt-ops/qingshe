/**
 * Solution 是轻舍统一的生活方案领域模型。
 * 它与 Recipe 不同：Recipe 是静态知识库中的菜谱，
 * 而 Solution 是面向用户真实生活场景的可执行方案抽象。
 */

export type SolutionType =
  | 'cooking'
  | 'fridge_cleanup'
  | 'moving'
  | 'storage'
  | 'diy'
  | 'shopping_decision';

export type SolutionStatus =
  | 'draft'
  | 'ready'
  | 'executing'
  | 'completed'
  | 'cancelled';

/**
 * 统一生活方案基础结构。
 * 不包含具体领域的完整数据，只保存跨方案通用的元信息。
 */
export interface Solution {
  id: string;
  type: SolutionType;

  title: string;
  description?: string;

  status: SolutionStatus;

  createdAt: string; // ISO date string
  updatedAt?: string; // ISO date string

  /** Solution 所依赖的真实生活数据引用，只保存 ID，不复制完整数据 */
  context?: SolutionContext;
}

/**
 * Solution 运行所依赖的真实生活数据上下文。
 * 只保存关联 ID 与明确引用，不复制完整用户数据。
 */
export interface SolutionContext {
  ingredientIds?: string[];
  recipeId?: string;
  relatedResourceIds?: string[];
  userInput?: string;
}

/**
 * Solution 完成后的轻量结果记录。
 * 不承载详细的 Reality Update 或 Life Record 数据，
 * 只标记是否已更新现实、是否已生成生活记录。
 */
export interface SolutionOutcome {
  solutionId: string;
  realityUpdated: boolean;
  lifeRecordId?: string;
  completedAt?: string; // ISO date string
}