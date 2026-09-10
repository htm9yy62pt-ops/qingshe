export type ExecutionResultStatus = 'pending_confirm' | 'confirmed' | 'cancelled';

export interface ConsumedIngredient {
  inventoryIngredientId?: string;
  name: string;
  plannedQuantity?: number;
  actualQuantity?: number;
  unit?: string;
  confirmed: boolean;
  hasInventoryMatch: boolean;
}

export interface RecipeExecutionResult {
  recipeId: string;
  title: string;
  consumedIngredients: ConsumedIngredient[];
  createdRecordDraft: {
    type: 'cooking';
    recipeId: string;
    title: string;
    completedAt: string;
  };
  status: ExecutionResultStatus;
}