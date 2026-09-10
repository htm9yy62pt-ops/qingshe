export type ExecutionStatus = 'preparing' | 'cooking' | 'completed' | 'cancelled';

export interface RecipeExecution {
  recipeId: string;
  title: string;
  sourceType: 'official' | 'user';
  status: ExecutionStatus;
  currentStepIndex: number; // -1 means preparing, 0..steps.length-1 means cooking
  startedAt: string; // ISO date string
  completedAt?: string; // ISO date string
}