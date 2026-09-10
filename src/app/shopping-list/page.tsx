'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ShoppingList, ShoppingListItem, resolveItemSource } from '@/lib/types/shopping-list';
import {
  getShoppingLists,
  toggleShoppingItem,
  cancelShoppingItem,
  removeShoppingItem,
  addItemsToShoppingList,
  markShoppingItemRestocked
} from '@/lib/reality/shopping-lists';
import { loadIngredients, saveIngredients } from '@/lib/reality/ingredients';
import {
  shoppingItemToRestockDraft,
  inventoryIngredientFromRestockDraft
} from '@/lib/ai/record';
import type { IngredientRecordDraft } from '@/lib/ai/record';
import type { IngredientCardAction } from '@/lib/types/chat';
import { IngredientConfirmCard } from '@/components/IngredientConfirmCard';
import { getLifeResources } from '@/lib/reality/life-resources';
import { LifeResource, LifeResourceType } from '@/lib/types/life-resource';
import { buildShoppingDecision } from '@/lib/shopping/shopping-decision';
import {
  ShoppingResourceMatch,
  ShoppingRecommendationReason
} from '@/lib/types/shopping-decision';
import { ShoppingItemFormModal } from '@/components/ShoppingItemFormModal';

function formatDate(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

export default function ShoppingListPage() {
  const [lists, setLists] = useState<ShoppingList[]>([]);
  const [lifeResources, setLifeResources] = useState<LifeResource[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  /**
   * P0-B 回程：勾选「已购买」后待确认的入库卡（单槽位）。
   * 卡片属于本页的当前任务，不进聊天消息流；确认前不写 qingshe_ingredients。
   */
  const [restockCard, setRestockCard] = useState<{
    listId: string;
    itemId: string;
    draft: IngredientRecordDraft;
  } | null>(null);

  useEffect(() => {
    setLists(getShoppingLists());
    setLifeResources(getLifeResources());
  }, []);

  const activeLists = lists.filter((list) =>
    list.items.some((item) => item.status === 'pending')
  );

  const completedLists = lists.filter((list) =>
    list.items.every((item) => item.status === 'purchased' || item.status === 'cancelled')
  );

  const handleToggle = (listId: string, itemId: string) => {
    const target = lists
      .find((l) => l.id === listId)
      ?.items.find((i) => i.id === itemId);
    setLists((prev) => toggleShoppingItem(prev, listId, itemId));
    if (!target) return;

    if (target.status === 'pending') {
      // 勾上 = 已购买：只产入库确认草稿，写不写库存由用户在卡片上决定。
      // restockedAt 有值的 item 在这里被 shoppingItemToRestockDraft 拦下（幂等）。
      const draft = shoppingItemToRestockDraft({ ...target, status: 'purchased' });
      if (draft) setRestockCard({ listId, itemId, draft });
    } else {
      // 取消勾选：撤回的是这次购买动作，对应的未处理入库卡一并收回。
      setRestockCard((cur) => (cur && cur.itemId === itemId ? null : cur));
    }
  };

  /**
   * 入库卡按钮。command 词汇与 IngredientCardAction 同源（confirm | cancel）。
   *
   * - confirm：saveIngredients 写真实库存 + markShoppingItemRestocked 落幂等标记，
   *   然后收卡。这是本页唯一的库存写入口。
   * - cancel：纯本地收卡，不写库存也不打标记 —— 取消可能是误点，
   *   重新勾选（pending → purchased）还能再出卡。
   */
  const handleRestockCardClick = (command: IngredientCardAction['command']) => {
    if (!restockCard) return;
    if (command === 'cancel') {
      setRestockCard(null);
      return;
    }
    const { listId, itemId, draft } = restockCard;
    saveIngredients([...loadIngredients(), inventoryIngredientFromRestockDraft(draft)]);
    setLists((prev) => markShoppingItemRestocked(prev, listId, itemId));
    setRestockCard(null);
  };

  const handleCancel = (listId: string, itemId: string) => {
    setLists((prev) => cancelShoppingItem(prev, listId, itemId));
  };

  const handleRemove = (listId: string, itemId: string) => {
    setLists((prev) => removeShoppingItem(prev, listId, itemId));
  };

  const handleManualAdd = (input: Parameters<typeof addItemsToShoppingList>[1]) => {
    setLists((prev) => addItemsToShoppingList(prev, input).lists);
  };

  const resourceTypeLabel: Record<LifeResourceType, string> = {
    supermarket: '超市',
    market: '市场',
    local_store: '本地店',
    online_store: '网店',
    other: '其他'
  };

  const reasonLabel: Record<ShoppingRecommendationReason, string> = {
    matching_tag: '匹配采购物品',
    favorite: '我的收藏',
    store_type: '适合当前场景',
    general: '通用推荐'
  };

  const openResourceUrl = (url: string | undefined) => {
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const getResourceUrl = (resourceId: string): string | undefined =>
    lifeResources.find((resource) => resource.id === resourceId)?.url;

  const renderItem = (list: ShoppingList, item: ShoppingListItem) => {
    const isDone = item.status === 'purchased' || item.status === 'cancelled';
    const sourceLabel = {
      recipe: '菜谱',
      manual: '手动',
      ai: 'AI'
    }[resolveItemSource(item)];

    return (
      <li
        key={item.id}
        className="flex items-center justify-between gap-3 py-3 border-b border-gray-100 last:border-0"
      >
        <label className="flex items-center gap-3 flex-1 cursor-pointer">
          <input
            type="checkbox"
            checked={item.status === 'purchased'}
            onChange={() => handleToggle(list.id, item.id)}
            className="w-5 h-5 rounded border-gray-300 text-green-500 focus:ring-green-200"
          />
          <div className="flex flex-col">
            <span
              className={`text-sm ${
                isDone ? 'text-gray-400 line-through' : 'text-gray-900'
              }`}
            >
              {item.name}
              {item.quantity != null && item.quantity !== ''
                ? ` · ${item.quantity}${item.unit ?? ''}`
                : ''}
            </span>
            <span className="text-[11px] text-gray-400">
              来源：{sourceLabel}
              {item.neededBy ? ` · 需要：${item.neededBy}` : ''}
              {item.restockedAt ? ' · 已入库' : ''}
            </span>
          </div>
        </label>
        <div className="flex items-center gap-1">
          {item.status === 'pending' && (
            <button
              type="button"
              onClick={() => handleCancel(list.id, item.id)}
              className="text-xs px-2 py-1 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-md"
            >
              取消
            </button>
          )}
          <button
            type="button"
            onClick={() => handleRemove(list.id, item.id)}
            className="text-xs px-2 py-1 text-red-500 hover:text-red-700 hover:bg-red-50 rounded-md"
          >
            删除
          </button>
        </div>
      </li>
    );
  };

  const renderDecisionOption = (match: ShoppingResourceMatch) => {
    const url = getResourceUrl(match.resourceId);

    return (
      <div
        key={match.resourceId}
        className="bg-gray-50 rounded-lg p-3"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-gray-900">
            {match.resourceName}
          </span>
          {url && (
            <button
              type="button"
              onClick={() => openResourceUrl(url)}
              className="text-xs px-2 py-1 text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded-md shrink-0"
            >
              访问店铺
            </button>
          )}
        </div>
        <p className="text-xs text-gray-600 mt-1">
          {resourceTypeLabel[match.resourceType]} · 匹配 {match.matchedItems.length} 件采购物品
          {match.reasons.length > 0 && (
            <span className="ml-1">· {match.reasons.map((reason) => reasonLabel[reason]).join('、')}</span>
          )}
        </p>
      </div>
    );
  };

  const renderDecision = (list: ShoppingList) => {
    const decision = buildShoppingDecision(list, lifeResources);
    const hasOptions =
      decision.immediateOptions.length > 0 || decision.plannedOptions.length > 0;

    return (
      <div className="mt-4 pt-4 border-t border-gray-100">
        <h3 className="text-sm font-medium text-gray-900 mb-3">购买建议</h3>
        {!hasOptions ? (
          <p className="text-sm text-gray-500">
            你的常用好店暂时没有匹配这些物品。
          </p>
        ) : (
          <div className="space-y-4">
            {decision.immediateOptions.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-gray-500 mb-2">
                  马上需要
                </h4>
                <div className="space-y-2">
                  {decision.immediateOptions.map(renderDecisionOption)}
                </div>
              </div>
            )}
            {decision.plannedOptions.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-gray-500 mb-2">
                  不着急
                </h4>
                <div className="space-y-2">
                  {decision.plannedOptions.map(renderDecisionOption)}
                </div>
              </div>
            )}
          </div>
        )}
        {decision.unmatchedItems.length > 0 && (
          <p className="mt-3 text-xs text-gray-400">
            未匹配：{decision.unmatchedItems.join('、')}
          </p>
        )}
      </div>
    );
  };

  const renderList = (list: ShoppingList) => (
    <div
      key={list.id}
      className="bg-white rounded-xl p-5 shadow-sm border border-gray-200"
    >
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold text-gray-900">{list.title}</h2>
        {list.completedAt && (
          <span className="text-xs text-gray-500">
            完成于 {formatDate(list.completedAt)}
          </span>
        )}
      </div>
      <ul>{list.items.map((item) => renderItem(list, item))}</ul>
      {list.items.some((item) => item.status === 'pending') && renderDecision(list)}
    </div>
  );

  return (
    <div className="flex flex-col min-h-screen">
      <main className="flex-1 bg-gray-50 pb-16">
        <div className="max-w-md mx-auto px-4 pt-12">
          <div className="flex items-center gap-2 mb-2">
            <Link href="/reality" className="text-gray-500 hover:text-gray-700">
              ← 家
            </Link>
            <h1 className="text-3xl font-bold">采购清单</h1>
          </div>
          <div className="flex items-center justify-between mb-6">
            <p className="text-gray-700">为真实生活方案准备的待购清单</p>
            <button
              type="button"
              onClick={() => setShowAddForm(true)}
              className="shrink-0 px-3 py-1.5 bg-blue-500 text-white text-sm rounded-md hover:bg-blue-600"
            >
              + 添加物品
            </button>
          </div>

          {lists.length === 0 ? (
            <div className="bg-white rounded-xl p-8 shadow-sm border border-gray-200 text-center">
              <div className="text-4xl mb-3">🛒</div>
              <h2 className="text-lg font-medium text-gray-900 mb-2">还没有采购清单</h2>
              <p className="text-gray-600 text-sm">
                在菜谱详情中点击「加入采购清单」，即可把需要购买的食材添加到这里。
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {restockCard && (
                <div>
                  <p className="text-xs text-gray-500">
                    已购买的物品要放进冰箱吗？确认后才会写入库存。
                  </p>
                  <IngredientConfirmCard
                    draft={restockCard.draft}
                    onConfirm={() => handleRestockCardClick('confirm')}
                    onCancel={() => handleRestockCardClick('cancel')}
                  />
                </div>
              )}
              {activeLists.length > 0 && (
                <div className="space-y-4">
                  <h2 className="text-sm font-medium text-gray-500">待完成</h2>
                  {activeLists.map(renderList)}
                </div>
              )}

              {completedLists.length > 0 && (
                <div className="space-y-4">
                  <h2 className="text-sm font-medium text-gray-500">已完成</h2>
                  {completedLists.map(renderList)}
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      <ShoppingItemFormModal
        open={showAddForm}
        onClose={() => setShowAddForm(false)}
        onSubmit={handleManualAdd}
      />
    </div>
  );
}