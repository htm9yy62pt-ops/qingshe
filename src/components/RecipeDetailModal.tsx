'use client';

import { useState } from 'react';
import { RecommendedRecipe } from '@/lib/types/chat';
import { Recipe, RecipeIngredient, RecipeStep } from '@/lib/types/recipe';
import { RecipeExecution } from '@/lib/types/execution';
import { RecipeExecutionResult } from '@/lib/types/execution-result';
import { InventoryIngredient } from '@/lib/types/ingredient';
import { consumeIngredients } from '@/lib/reality/ingredients';
import { buildCookingLifeRecordDraft, saveLifeRecord } from '@/lib/reality/life-records';
import { LifeRecordDraft } from '@/lib/types/life-record';
import {
  recipeIngredientsToShoppingDrafts,
  type ShoppingItemDraft
} from '@/lib/ai/tasks';
import { RecipeExecutionPanel } from './RecipeExecutionPanel';
import { ExecutionResultConfirm } from './ExecutionResultConfirm';
import { LifeRecordDraftConfirm } from './LifeRecordDraftConfirm';

const DIFFICULTY_LABEL: Record<string, string> = {
  easy: '简单',
  medium: '中等',
  hard: '较难'
};

interface RecipeDetailModalProps {
  recommended: RecommendedRecipe;
  fullRecipe?: Recipe | null;
  ingredients?: InventoryIngredient[];
  onClose: () => void;
  onStartCooking?: (recipeId: string) => void;
  onInventoryUpdated?: (ingredients: InventoryIngredient[]) => void;
  /**
   * 缺料转采购草稿后的唯一出口：把草稿交给聊天页现成的 Shopping Draft
   * 确认卡去走「确认 → commitShoppingDrafts」链路。弹窗自己从不写清单。
   */
  onAddShoppingDrafts?: (drafts: ShoppingItemDraft[]) => void;
}

function renderIngredientList(list: RecipeIngredient[]): string {
  return list
    .map((item) => {
      const quantity = item.quantity ? `${item.quantity}${item.unit || ''}` : '';
      return quantity ? `${item.name}（${quantity}）` : item.name;
    })
    .join('、');
}

function renderSteps(steps: RecipeStep[]): string {
  return steps.map((step) => `${step.step}. ${step.content}`).join('\n');
}

function buildReason(recommended: RecommendedRecipe): string {
  if (recommended.urgentIngredientsUsed.length > 0) {
    return `这个方案会优先用到你的临期食材（${recommended.urgentIngredientsUsed.join('、')}），帮你减少浪费。`;
  }
  if (recommended.missingIngredients.length === 0) {
    return '你已有全部所需食材，可以直接尝试。';
  }
  if (recommended.availableIngredients.length > 0) {
    return '你已有一部分食材，只需要补充少量材料即可尝试。';
  }
  return '这个菜谱看起来适合你当前的需求。';
}

export function RecipeDetailModal({
  recommended,
  fullRecipe,
  ingredients = [],
  onClose,
  onStartCooking,
  onInventoryUpdated,
  onAddShoppingDrafts
}: RecipeDetailModalProps) {
  const [execution, setExecution] = useState<RecipeExecution | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [result, setResult] = useState<RecipeExecutionResult | null>(null);
  const [lifeRecordDraft, setLifeRecordDraft] = useState<LifeRecordDraft | null>(null);
  const [shoppingNotice, setShoppingNotice] = useState<string | null>(null);
  // 防止 ExecutionResultConfirm 提交后 parent 端被多次调用造成重复扣库存
  const [hasConfirmedResult, setHasConfirmedResult] = useState(false);
  const hasFullRecipe = fullRecipe != null;

  const handleStartCooking = () => {
    const newExecution: RecipeExecution = {
      recipeId: recommended.recipeId,
      title: recommended.title,
      sourceType: recommended.sourceType,
      status: 'preparing',
      currentStepIndex: -1,
      startedAt: new Date().toISOString()
    };
    setExecution(newExecution);
    setShowConfirm(false);
    setResult(null);
    setLifeRecordDraft(null);
    setHasConfirmedResult(false);
    onStartCooking?.(recommended.recipeId);
  };

  const handleConfirmResult = (confirmedResult: RecipeExecutionResult) => {
    // 防御性：已确认过则不再执行库存更新（防止重复扣减）
    if (hasConfirmedResult) return;

    setHasConfirmedResult(true);

    try {
      const confirmedConsumed = confirmedResult.consumedIngredients.filter(
        (item) => item.confirmed && item.hasInventoryMatch && item.inventoryIngredientId
      );

      // 库存写入交回 Reality Service 的 consumeIngredients：它在写之前现读一次
      // qingshe_ingredients。本组件手里的 ingredients 只是打开弹窗那一刻的展示快照，
      // 拿它当写回基线会把快照之后新增或入库的食材整包覆盖掉。
      // 只有 confirmed 且匹配到库存条目的消耗项会改变数量，其余记录原样保留。
      const updatedIngredients = consumeIngredients(confirmedConsumed);

      // 把落库后的最新库存回传给页面，顺手对齐它自己那份快照。
      onInventoryUpdated?.(updatedIngredients);

      const completedExecution: RecipeExecution = execution
        ? {
            ...execution,
            status: 'completed',
            completedAt: new Date().toISOString()
          }
        : {
            recipeId: recommended.recipeId,
            title: recommended.title,
            sourceType: recommended.sourceType,
            status: 'completed',
            currentStepIndex: -1,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString()
          };

      const draft = buildCookingLifeRecordDraft({
        execution: completedExecution,
        result: confirmedResult,
        recommended
      });

      // 顺序：先关闭 ExecutionResultConfirm，再打开 LifeRecordDraftConfirm。
      // 关键修复：必须先 setShowConfirm(false)，
      // 否则 renderContent 优先匹配 showConfirm 分支，
      // 用户会看到 ExecutionResultConfirm 仍然显示"更新中..."按钮且无法进入下一步。
      setShowConfirm(false);
      setResult(confirmedResult);
      setExecution(completedExecution);
      setLifeRecordDraft(draft);
    } catch (error) {
      // 失败时解锁，允许用户重试
      setHasConfirmedResult(false);
      throw error;
    }
  };

  const handleCancelResult = () => {
    setShowConfirm(false);
    setResult((prev) =>
      prev
        ? {
            ...prev,
            status: 'cancelled'
          }
        : null
    );
    setHasConfirmedResult(false);
  };

  const handleClose = () => {
    setExecution(null);
    setShowConfirm(false);
    setResult(null);
    setLifeRecordDraft(null);
    setHasConfirmedResult(false);
    onClose();
  };

  const handleAddToShoppingList = () => {
    const drafts = recipeIngredientsToShoppingDrafts(
      fullRecipe?.ingredients ?? [],
      recommended.missingIngredients ?? []
    );
    if (drafts.length === 0) {
      setShoppingNotice('这个菜谱没有需要购买的食材。');
      return;
    }
    onAddShoppingDrafts?.(drafts);
    onClose();
  };

  const renderContent = () => {
    if (showConfirm) {
      return (
        <ExecutionResultConfirm
          recommended={recommended}
          fullRecipe={fullRecipe ?? null}
          ingredients={ingredients}
          onConfirm={handleConfirmResult}
          onCancel={handleCancelResult}
        />
      );
    }

    if (lifeRecordDraft) {
      return (
        <LifeRecordDraftConfirm
          draft={lifeRecordDraft}
          onSave={(savedDraft) => {
            saveLifeRecord(savedDraft);
          }}
          onDiscard={handleClose}
        />
      );
    }

    if (result) {
      return (
        <div className="mt-4">
          <div className="bg-green-50 rounded-lg p-4 text-sm text-green-800">
            <p className="font-medium">已确认本次制作结果</p>
            <p className="mt-1">
              确认消耗 {result.consumedIngredients.length} 样食材，生活记录草稿已准备。
            </p>
          </div>
          <div className="mt-4 flex gap-3">
            <button
              type="button"
              onClick={handleClose}
              className="flex-1 py-3 bg-blue-500 text-white rounded-lg font-medium hover:bg-blue-600"
            >
              关闭
            </button>
          </div>
        </div>
      );
    }

    if (execution) {
      return (
        <div className="mt-2">
          <RecipeExecutionPanel
            execution={execution}
            steps={fullRecipe?.steps ?? []}
            onUpdate={setExecution}
            onRequestConfirm={() => setShowConfirm(true)}
            onCancel={() => setExecution(null)}
          />
        </div>
      );
    }

    return (
      <>
        {recommended.sourceType === 'user' && (
          <span className="inline-block mt-2 text-xs text-blue-700 bg-blue-50 px-2 py-0.5 rounded">
            我的菜谱
          </span>
        )}

        {recommended.description && (
          <p className="mt-3 text-sm text-gray-600">{recommended.description}</p>
        )}

        <div className="mt-4 bg-amber-50 rounded-lg p-3 text-sm text-amber-800">
          <span className="font-medium">推荐原因：</span>
          {buildReason(recommended)}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
          {recommended.estimatedTime != null && (
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-gray-400 text-xs">预计时间</div>
              <div className="text-gray-800 font-medium">约 {recommended.estimatedTime} 分钟</div>
            </div>
          )}
          {recommended.difficulty && (
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-gray-400 text-xs">难度</div>
              <div className="text-gray-800 font-medium">
                {DIFFICULTY_LABEL[recommended.difficulty] ?? recommended.difficulty}
              </div>
            </div>
          )}
        </div>

        <div className="mt-4 space-y-3">
          <div className="bg-green-50 rounded-lg p-3">
            <div className="text-xs font-medium text-green-800 mb-1">已有食材</div>
            <div className="text-sm text-green-900">
              {recommended.availableIngredients.length > 0
                ? recommended.availableIngredients.join('、')
                : '暂无已确认的食材'}
            </div>
          </div>

          <div className="bg-gray-50 rounded-lg p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-xs font-medium text-gray-700 mb-1">系统未记录 / 可能需要</div>
                <div className="text-sm text-gray-600">
                  {recommended.missingIngredients.length > 0
                    ? recommended.missingIngredients.join('、')
                    : '不需要额外补充'}
                </div>
              </div>
              {recommended.missingIngredients.length > 0 && (
                <button
                  type="button"
                  onClick={handleAddToShoppingList}
                  className="shrink-0 text-xs px-2 py-1 bg-blue-500 text-white rounded-md hover:bg-blue-600"
                >
                  加入采购清单
                </button>
              )}
              {shoppingNotice && (
                <p className="mt-1 w-full text-xs text-amber-700">{shoppingNotice}</p>
              )}
            </div>
          </div>

          {recommended.urgentIngredientsUsed.length > 0 && (
            <div className="bg-amber-50 rounded-lg p-3">
              <div className="text-xs font-medium text-amber-800 mb-1">临期食材</div>
              <div className="text-sm text-amber-900">
                {recommended.urgentIngredientsUsed.join('、')}
              </div>
            </div>
          )}
        </div>

        {hasFullRecipe && (
          <div className="mt-5 space-y-4">
            <section>
              <h3 className="text-sm font-medium text-gray-900 mb-2">完整食材需求</h3>
              <div className="text-sm text-gray-700 bg-gray-50 rounded-lg p-3">
                <p className="font-medium text-gray-900">必需：</p>
                <p className="mb-2">
                  {renderIngredientList(fullRecipe.ingredients.filter((i) => i.required))}
                </p>
                {fullRecipe.optionalIngredients.length > 0 && (
                  <>
                    <p className="font-medium text-gray-900">可选：</p>
                    <p>{renderIngredientList(fullRecipe.optionalIngredients)}</p>
                  </>
                )}
              </div>
            </section>

            <section>
              <h3 className="text-sm font-medium text-gray-900 mb-2">制作步骤</h3>
              <div className="text-sm text-gray-700 bg-gray-50 rounded-lg p-3 whitespace-pre-line">
                {renderSteps(fullRecipe.steps)}
              </div>
            </section>
          </div>
        )}

        {!hasFullRecipe && (
          <p className="mt-5 text-sm text-gray-500">未找到完整菜谱步骤。</p>
        )}

        <div className="mt-6 flex gap-3">
          <button
            type="button"
            onClick={handleStartCooking}
            className="flex-1 py-3 bg-blue-500 text-white rounded-lg font-medium hover:bg-blue-600"
          >
            开始制作
          </button>
          <button
            type="button"
            onClick={handleClose}
            className="flex-1 py-3 border border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-50"
          >
            关闭
          </button>
        </div>
      </>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-2xl w-full max-w-md max-h-[85vh] overflow-y-auto shadow-xl">
        <div className="p-5">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-xl font-bold text-gray-900">
              {execution ? execution.title : recommended.title}
            </h2>
            <button
              type="button"
              onClick={handleClose}
              className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
              aria-label="关闭"
            >
              ×
            </button>
          </div>

          {renderContent()}
        </div>
      </div>
    </div>
  );
}