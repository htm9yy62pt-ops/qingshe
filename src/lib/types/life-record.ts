export type LifeRecordType = 'cooking';

export type LifeRecordStatus = 'draft' | 'saved';

export type LifeRecordVisibility = 'private' | 'public';

export interface LifeRecordUsedIngredient {
  name: string;
  inventoryIngredientId?: string;
  actualQuantity?: number;
  unit?: string;
}

export interface LifeRecordDraft {
  id: string;
  type: LifeRecordType;
  title: string;
  recipeId?: string;
  recipeTitle?: string;
  summary: string;
  usedIngredients: LifeRecordUsedIngredient[];
  completedAt: string;
  createdAt: string;
  status: LifeRecordStatus;
  visibility: LifeRecordVisibility;

  /** 与统一 Solution 模型的未来关联，可选以保持向后兼容 */
  solutionId?: string;
  solutionType?: import('@/lib/types/solution').SolutionType;
}