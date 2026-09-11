'use client';

import { useMemo, useState, useCallback } from 'react';
import { RecommendedRecipe } from '@/lib/types/chat';
import { Recipe, RecipeIngredient } from '@/lib/types/recipe';
import { InventoryIngredient } from '@/lib/types/ingredient';
import { RecipeExecutionResult, ConsumedIngredient } from '@/lib/types/execution-result';

interface ExecutionResultConfirmProps {
  recommended: RecommendedRecipe;
  fullRecipe: Recipe | null;
  ingredients: InventoryIngredient[];
  onConfirm: (result: RecipeExecutionResult) => void;
  onCancel: () => void;
}

function parseQuantity(value: string | undefined): number | undefined {
  if (value == null || value === '') return undefined;
  const parsed = parseFloat(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function findInventoryIngredient(
  name: string,
  ingredients: InventoryIngredient[]
): InventoryIngredient | undefined {
  return ingredients.find(
    (item) => item.name.trim().toLowerCase() === name.trim().toLowerCase()
  );
}

function buildInitialConsumed(
  required: RecipeIngredient[],
  ingredients: InventoryIngredient[]
): ConsumedIngredient[] {
  return required.map((item) => {
    const matched = findInventoryIngredient(item.name, ingredients);
    const planned = parseQuantity(item.quantity);
    return {
      inventoryIngredientId: matched?.id,
      name: item.name,
      plannedQuantity: planned,
      actualQuantity: planned,
      unit: item.unit,
      confirmed: matched != null,
      hasInventoryMatch: matched != null
    };
  });
}

export function ExecutionResultConfirm({
  recommended,
  fullRecipe,
  ingredients,
  onConfirm,
  onCancel
}: ExecutionResultConfirmProps) {
  const requiredIngredients = useMemo(
    () => fullRecipe?.ingredients.filter((i) => i.required) ?? [],
    [fullRecipe]
  );

  const optionalIngredients = useMemo(
    () => fullRecipe?.optionalIngredients ?? [],
    [fullRecipe]
  );

  const [consumedItems, setConsumedItems] = useState<ConsumedIngredient[]>(() =>
    buildInitialConsumed(requiredIngredients, ingredients)
  );

  const [isEditing, setIsEditing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const updateItem = useCallback((name: string, patch: Partial<ConsumedIngredient>) => {
    setConsumedItems((prev) =>
      prev.map((item) => (item.name === name ? { ...item, ...patch } : item))
    );
  }, []);

  const matchedItems = consumedItems.filter((i) => i.hasInventoryMatch);
  const unmatchedItems = consumedItems.filter((i) => !i.hasInventoryMatch);

  const handleConfirm = () => {
    if (isSubmitting) return;
    setIsSubmitting(true);

    const confirmedConsumed = consumedItems.filter(
      (item) => item.confirmed && item.hasInventoryMatch && item.inventoryIngredientId
    );

    try {
      onConfirm({
        recipeId: recommended.recipeId,
        title: recommended.title,
        consumedIngredients: confirmedConsumed,
        createdRecordDraft: {
          type: 'cooking',
          recipeId: recommended.recipeId,
          title: recommended.title,
          completedAt: new Date().toISOString()
        },
        status: 'confirmed'
      });
      // 注意：parent 成功后会 setShowConfirm(false)，本组件被卸载，
      // isSubmitting 状态随组件销毁而消失，无需手动 reset。
      // 这里在 finally 块中加一道兜底：
      // 如果 parent 因异常没有关闭 showConfirm，仍允许用户重试。
    } catch (error) {
      console.error('ExecutionResultConfirm handleConfirm error:', error);
      setIsSubmitting(false);
    }
  };

  const renderMatchedRow = (item: ConsumedIngredient) => {
    const inventory = item.inventoryIngredientId
      ? ingredients.find((i) => i.id === item.inventoryIngredientId)
      : undefined;

    return (
      <li key={item.name} className="py-2 text-sm border-b border-gray-100 last:border-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={item.confirmed}
              onChange={(e) => updateItem(item.name, { confirmed: e.target.checked })}
              className="h-4 w-4 text-blue-600 rounded border-gray-300"
            />
            <span className="text-gray-900 font-medium">{item.name}</span>
          </div>
          <span className="text-xs text-gray-500">
            库存 {inventory?.quantity ?? '—'}
            {inventory?.unit}
          </span>
        </div>

        {isEditing && item.confirmed && (
          <div className="mt-2 flex items-center gap-2 pl-6">
            <label className="text-xs text-gray-500">实际消耗</label>
            <input
              type="number"
              min={0}
              step="0.1"
              value={item.actualQuantity ?? ''}
              placeholder={item.plannedQuantity != null ? String(item.plannedQuantity) : '请输入'}
              onChange={(e) => {
                const value = e.target.value;
                const parsed = value === '' ? undefined : parseFloat(value);
                updateItem(item.name, {
                  actualQuantity: value === '' || Number.isNaN(parsed) ? undefined : parsed
                });
              }}
              className="w-24 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-200"
            />
            <span className="text-xs text-gray-500">{item.unit ?? inventory?.unit ?? ''}</span>
            {item.plannedQuantity != null && (
              <span className="text-xs text-gray-400">
                菜谱建议 {item.plannedQuantity}
                {item.unit ?? ''}
              </span>
            )}
          </div>
        )}

        {!isEditing && item.confirmed && (
          <div className="mt-1 pl-6 text-xs text-gray-500">
            计划消耗 {item.actualQuantity ?? item.plannedQuantity ?? '—'}
            {item.unit ?? inventory?.unit ?? ''}
          </div>
        )}
      </li>
    );
  };

  return (
    <div>
      <h3 className="text-lg font-bold text-gray-900">本次制作：{recommended.title}</h3>

      <div className="mt-4 bg-blue-50 rounded-lg p-3 text-sm text-blue-800">
        请确认本次实际消耗的食材。已关联厨房库存的食材会按你填写的数量更新。
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-sm font-medium text-gray-900">预计消耗（菜谱必需食材）</h4>
          <button
            type="button"
            onClick={() => setIsEditing((v) => !v)}
            className="text-xs text-blue-600 hover:text-blue-700"
          >
            {isEditing ? '完成修改' : '修改消耗'}
          </button>
        </div>

        {matchedItems.length > 0 && (
          <ul className="bg-gray-50 rounded-lg px-3">{matchedItems.map(renderMatchedRow)}</ul>
        )}

        {unmatchedItems.length > 0 && (
          <div className="mt-2 bg-gray-50 rounded-lg px-3 py-2">
            <div className="text-xs font-medium text-gray-700 mb-1">系统未记录 / 无法自动更新</div>
            <div className="text-sm text-gray-500">
              {unmatchedItems.map((i) => i.name).join('、')}
            </div>
          </div>
        )}

        {matchedItems.length === 0 && unmatchedItems.length === 0 && (
          <p className="text-sm text-gray-500 bg-gray-50 rounded-lg px-3 py-2">
            未记录必需食材
          </p>
        )}
      </div>

      {optionalIngredients.length > 0 && (
        <div className="mt-3">
          <h4 className="text-sm font-medium text-gray-700 mb-1">可选食材（不强制消耗）</h4>
          <div className="text-sm text-gray-500 bg-gray-50 rounded-lg px-3 py-2">
            {optionalIngredients.map((i) => i.name).join('、')}
          </div>
        </div>
      )}

      {recommended.missingIngredients.length > 0 && (
        <div className="mt-3">
          <h4 className="text-sm font-medium text-gray-700 mb-1">菜谱需要但系统未确认</h4>
          <div className="text-sm text-gray-500 bg-gray-50 rounded-lg px-3 py-2">
            {recommended.missingIngredients.join('、')}
          </div>
        </div>
      )}

      <div className="mt-5 text-sm font-medium text-gray-900">
        确认以上消耗并更新厨房？
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleConfirm}
          disabled={isSubmitting}
          className={`px-4 py-2 rounded-lg text-white ${
            isSubmitting
              ? 'bg-gray-400 cursor-not-allowed'
              : 'bg-green-500 hover:bg-green-600'
          }`}
        >
          {isSubmitting ? '更新中...' : '确认更新'}
        </button>
        <button
          type="button"
          onClick={() => setIsEditing((v) => !v)}
          disabled={isSubmitting}
          className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isEditing ? '完成修改' : '修改消耗'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={isSubmitting}
          className="ml-auto px-4 py-2 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          取消
        </button>
      </div>
    </div>
  );
}