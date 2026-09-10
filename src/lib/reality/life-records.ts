import { LifeRecordDraft, LifeRecordUsedIngredient } from '@/lib/types/life-record';
import { RecipeExecutionResult, ConsumedIngredient } from '@/lib/types/execution-result';
import { RecipeExecution } from '@/lib/types/execution';
import { RecommendedRecipe } from '@/lib/types/chat';

const STORAGE_KEY = 'qingshe_life_records';

export function loadLifeRecords(): LifeRecordDraft[] {
  if (typeof window === 'undefined') return [];
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as LifeRecordDraft[];
  } catch {
    return [];
  }
}

export function saveLifeRecord(record: LifeRecordDraft): LifeRecordDraft[] {
  const records = loadLifeRecords();
  const nextRecords = [record, ...records];
  if (typeof window !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextRecords));
  }
  return nextRecords;
}

export function updateLifeRecord(record: LifeRecordDraft): LifeRecordDraft[] {
  const records = loadLifeRecords();
  const nextRecords = records.map((item) => (item.id === record.id ? record : item));
  if (typeof window !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextRecords));
  }
  return nextRecords;
}

export function deleteLifeRecord(id: string): LifeRecordDraft[] {
  const records = loadLifeRecords();
  const nextRecords = records.filter((item) => item.id !== id);
  if (typeof window !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextRecords));
  }
  return nextRecords;
}

function buildSummary(
  recipeTitle: string,
  usedNames: string[],
  urgentNames: string[]
): string {
  if (usedNames.length === 0) {
    return `今天完成了「${recipeTitle}」。`;
  }

  let summary = `今天完成了「${recipeTitle}」，并使用了冰箱中的${usedNames.join('、')}。`;

  if (urgentNames.length > 0) {
    summary += `同时优先处理了临期食材：${urgentNames.join('、')}。`;
  }

  return summary;
}

export interface BuildCookingDraftInput {
  execution: RecipeExecution;
  result: RecipeExecutionResult;
  recommended: RecommendedRecipe;
}

export function buildCookingLifeRecordDraft({
  execution,
  result,
  recommended
}: BuildCookingDraftInput): LifeRecordDraft {
  const confirmedConsumed = result.consumedIngredients.filter(
    (item): item is ConsumedIngredient &
      Required<Pick<ConsumedIngredient, 'inventoryIngredientId'>> =>
      item.confirmed && item.hasInventoryMatch && item.inventoryIngredientId != null
  );

  const usedIngredients: LifeRecordUsedIngredient[] = confirmedConsumed.map((item) => ({
    name: item.name,
    inventoryIngredientId: item.inventoryIngredientId,
    actualQuantity: item.actualQuantity,
    unit: item.unit
  }));

  const usedNames = usedIngredients.map((item) => item.name);
  const urgentNames = usedNames.filter((name) =>
    recommended.urgentIngredientsUsed.includes(name)
  );

  const completedAt = execution.completedAt ?? result.createdRecordDraft.completedAt;

  return {
    id: `life_record_${Date.now()}`,
    type: 'cooking',
    title: result.title,
    recipeId: result.recipeId,
    recipeTitle: result.title,
    summary: buildSummary(result.title, usedNames, urgentNames),
    usedIngredients,
    completedAt,
    createdAt: new Date().toISOString(),
    status: 'draft',
    visibility: 'private'
  };
}