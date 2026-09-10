'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { loadConsumables } from '@/lib/reality/consumables';
import { applyConsumableStatusUpdates } from '@/lib/reality/consumable-updates';
import { getLifeResources } from '@/lib/reality/life-resources';
import { getShoppingLists, addItemsToShoppingList } from '@/lib/reality/shopping-lists';
import { buildReplenishmentDecision } from '@/lib/shopping/replenishment-decision';
import type { ConsumableItem, ConsumableStatus } from '@/lib/types/consumable';

/**
 * 状态标签：单一映射，避免各处硬编码文案
 */
const STATUS_META: Record<ConsumableStatus, { label: string; className: string }> = {
  unknown: { label: '待观察', className: 'bg-gray-100 text-gray-600' },
  learning: { label: '学习中', className: 'bg-blue-50 text-blue-600' },
  estimated: { label: '有预计', className: 'bg-indigo-50 text-indigo-600' },
  running_low: { label: '快用完', className: 'bg-amber-50 text-amber-700' },
  finished: { label: '已用完', className: 'bg-gray-100 text-gray-400' }
};

export default function ConsumablesPage() {
  const [consumables, setConsumables] = useState<ConsumableItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setConsumables(loadConsumables());
    setLoaded(true);
  }, []);

  const active = consumables.filter((c) => c.status !== 'finished');
  const finished = consumables.filter((c) => c.status === 'finished');

  // 紧急补货判定：纯函数，只读不写。是否加入采购清单由用户点按钮决定。
  const lifeResources = loaded ? getLifeResources() : [];
  const urgent = active
    .map((item) => ({
      item,
      decision: buildReplenishmentDecision(item, lifeResources, item.estimatedRunOutDays)
    }))
    .filter((entry) => entry.decision.urgency === 'urgent');

  const handleFinished = (item: ConsumableItem) => {
    // 走统一写入编排：消耗品置 finished 的同时撤销它的提醒
    applyConsumableStatusUpdates([
      { consumableId: item.id, urgency: 'urgent', markFinished: true, remainingQuantity: 0 }
    ]);
    setConsumables(loadConsumables());
  };

  const handleAddUrgentToShoppingList = () => {
    addItemsToShoppingList(
      getShoppingLists(),
      {
        items: urgent.map(({ item }) => ({
          name: item.name,
          ...(item.unit ? { unit: item.unit } : {})
        })),
        source: 'ai'
      }
    );
  };

  return (
    <div className="flex flex-col min-h-screen">
      <main className="flex-1 bg-gray-50 pb-16">
        <div className="max-w-md mx-auto px-4 pt-12">
          {/* Header */}
          <div className="flex items-center gap-2 mb-2">
            <Link href="/reality" className="text-gray-500 hover:text-gray-700">
              ← 家
            </Link>
            <h1 className="text-3xl font-bold">消耗品</h1>
          </div>
          <div className="flex items-center justify-between mb-6">
            <p className="text-gray-700">
              {active.length} 件在用
              {urgent.length > 0 ? ` · ${urgent.length} 件该补货` : ''}
            </p>
            <Link
              href="/"
              className="shrink-0 px-3 py-1.5 bg-amber-500 text-white text-sm rounded-md hover:bg-amber-600"
            >
              + 告诉 AI
            </Link>
          </div>

          {/* 紧急补货 */}
          {urgent.length > 0 && (
            <div className="mb-4 bg-white rounded-xl p-5 shadow-sm border border-red-200">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold text-red-600">该补货了</h2>
                <span className="text-xs text-gray-500">
                  按现有余量与消耗速度推算
                </span>
              </div>
              <ul className="space-y-2">
                {urgent.map(({ item, decision }) => (
                  <li
                    key={item.id}
                    className="text-sm"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-gray-900">
                        {item.name}
                        {item.quantity != null
                          ? ` · 剩 ${item.quantity}${item.unit ?? ''}`
                          : ''}
                      </span>
                      <span className="shrink-0 text-xs text-red-600">
                        {item.estimatedRunOutDays != null
                          ? `约剩 ${item.estimatedRunOutDays} 天`
                          : '余量未知'}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-gray-500">{decision.message}</p>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={handleAddUrgentToShoppingList}
                className="mt-4 w-full py-2 bg-red-500 text-white text-sm rounded-md hover:bg-red-600"
              >
                全部加入采购清单
              </button>
            </div>
          )}

          {/* 列表 */}
          {loaded && active.length === 0 && finished.length === 0 ? (
            <div className="bg-white rounded-xl p-8 shadow-sm border border-gray-200 text-center">
              <div className="text-4xl mb-3">🧺</div>
              <p className="text-lg font-medium text-gray-900 mb-2">还没有消耗品</p>
              <p className="text-gray-600 text-sm mb-4">
                在 AI 对话里说「今天买了1箱面巾纸，放在储物间」
              </p>
              <Link
                href="/"
                className="inline-block px-4 py-2 bg-amber-500 text-white text-sm rounded-md hover:bg-amber-600"
              >
                去记录
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              {active.map((item) => (
                <ConsumableRow key={item.id} item={item} onFinished={handleFinished} />
              ))}
              {finished.length > 0 && (
                <div className="pt-2">
                  <p className="text-sm font-medium text-gray-500 mb-2">
                    已用完 {finished.length}
                  </p>
                  <div className="space-y-3">
                    {finished.map((item) => (
                      <ConsumableRow
                        key={item.id}
                        item={item}
                        onFinished={handleFinished}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function ConsumableRow({
  item,
  onFinished
}: {
  item: ConsumableItem;
  onFinished: (item: ConsumableItem) => void;
}) {
  const meta = STATUS_META[item.status];
  const done = item.status === 'finished';

  return (
    <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-200">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={`text-lg font-semibold truncate ${done ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
            {item.name}
          </p>
          <p className="text-sm text-gray-500 mt-0.5">
            {item.quantity != null ? `剩 ${item.quantity}${item.unit ?? ''}` : '数量未知'}
            {item.location ? ` · ${item.location}` : ''}
          </p>
        </div>
        <span className={`shrink-0 px-2 py-0.5 rounded text-xs font-medium ${meta.className}`}>
          {meta.label}
        </span>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 text-xs text-gray-500">
        <span>
          {item.estimatedRunOutDays != null
            ? `预计 ${item.estimatedRunOutDays} 天后用完`
            : item.checkIntervalDays != null
              ? `${item.checkIntervalDays} 天确认一次`
              : '还没给出使用节奏'}
        </span>
        {!done && (
          <button
            type="button"
            onClick={() => onFinished(item)}
            className="shrink-0 px-2.5 py-1 border border-gray-200 rounded-md text-gray-600 hover:bg-gray-50"
          >
            用完了
          </button>
        )}
      </div>
    </div>
  );
}