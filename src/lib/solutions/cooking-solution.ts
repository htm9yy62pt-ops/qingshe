import { Solution, SolutionContext, SolutionStatus, SolutionType } from '@/lib/types/solution';
import { RecipeExecution } from '@/lib/types/execution';
import { RecipeExecutionResult } from '@/lib/types/execution-result';
import { Recipe } from '@/lib/types/recipe';

const EXECUTION_TO_SOLUTION_STATUS: Record<
  RecipeExecution['status'],
  SolutionStatus
> = {
  preparing: 'executing',
  cooking: 'executing',
  completed: 'completed',
  cancelled: 'cancelled'
};

export interface CreateCookingSolutionInput {
  execution: RecipeExecution;
  recipe?: Recipe | null;
  result?: RecipeExecutionResult | null;
}

/**
 * 将 Cooking 执行过程映射为未来统一的 Solution 概念。
 * 不修改任何现有 Cooking 数据结构，只做轻量转换。
 */
export function createCookingSolution({
  execution,
  recipe,
  result
}: CreateCookingSolutionInput): Solution {
  const type: SolutionType = 'cooking';

  const context: SolutionContext | undefined =
    result || recipe
      ? {
          recipeId: recipe?.id ?? execution.recipeId,
          ingredientIds: result?.consumedIngredients
            .filter((item) => item.confirmed && item.inventoryIngredientId)
            .map((item) => item.inventoryIngredientId as string)
        }
      : undefined;

  return {
    id: `solution_${type}_${Date.now()}`,
    type,
    title: recipe?.title ?? execution.title,
    description: recipe?.description,
    status: EXECUTION_TO_SOLUTION_STATUS[execution.status],
    createdAt: execution.startedAt,
    updatedAt: execution.completedAt ?? new Date().toISOString(),
    ...(context ? { context } : {})
  };
}

/**
 * 将 Solution 关联到 Life Record 时生成稳定 ID。
 */
export function createSolutionOutcome(
  solutionId: string,
  lifeRecordId?: string
): import('@/lib/types/solution').SolutionOutcome {
  return {
    solutionId,
    realityUpdated: true,
    lifeRecordId,
    completedAt: new Date().toISOString()
  };
}