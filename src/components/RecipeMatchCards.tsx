'use client';

import { RecommendedRecipe } from '@/lib/types/chat';

const DIFFICULTY_LABEL: Record<string, string> = {
  easy: '简单',
  medium: '中等',
  hard: '较难'
};

interface RecipeMatchCardsProps {
  matches?: RecommendedRecipe[];
  onRecipeClick?: (recipeId: string) => void;
}

export function RecipeMatchCards({ matches, onRecipeClick }: RecipeMatchCardsProps) {
  if (!matches || matches.length === 0) return null;

  return (
    <div className="mt-3 space-y-2">
      <p className="text-xs text-gray-500">为你想到的方案：</p>
      {matches.map((recipe) => (
        <button
          key={recipe.recipeId}
          type="button"
          onClick={() => onRecipeClick?.(recipe.recipeId)}
          className="w-full text-left bg-white border border-gray-200 rounded-lg p-3 hover:border-blue-300 hover:shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-blue-200"
        >
          <div className="flex items-start justify-between gap-2">
            <h4 className="text-sm font-medium text-gray-900">{recipe.title}</h4>
            {recipe.sourceType === 'user' && (
              <span className="shrink-0 text-[10px] text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded">
                我的菜谱
              </span>
            )}
          </div>

          {recipe.description && (
            <p className="mt-1 text-xs text-gray-500 line-clamp-2">{recipe.description}</p>
          )}

          {recipe.urgentIngredientsUsed.length > 0 && (
            <div className="mt-2 text-[11px] text-amber-700 bg-amber-50 rounded px-2 py-1">
              优先消耗临期食材：{recipe.urgentIngredientsUsed.join('、')}
            </div>
          )}

          <div className="mt-2 text-[11px] text-gray-600">
            已有 {recipe.availableIngredients.length} 样：
            {recipe.availableIngredients.length > 0
              ? recipe.availableIngredients.join('、')
              : '—'}
          </div>

          <div className="mt-0.5 text-[11px] text-gray-500">
            可能缺少 {recipe.missingIngredients.length} 样：
            {recipe.missingIngredients.length > 0
              ? recipe.missingIngredients.join('、')
              : '无'}
          </div>

          <div className="mt-2 flex items-center justify-between">
            <div className="flex gap-2 text-[11px] text-gray-400">
              {recipe.estimatedTime != null && (
                <span>约 {recipe.estimatedTime} 分钟</span>
              )}
              {recipe.difficulty && (
                <span>难度 {DIFFICULTY_LABEL[recipe.difficulty] ?? recipe.difficulty}</span>
              )}
            </div>
            <span className="text-[11px] text-blue-600">查看做法 →</span>
          </div>
        </button>
      ))}
    </div>
  );
}