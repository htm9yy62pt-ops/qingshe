'use client';

import { useState, type ReactNode } from 'react';
import type { ShoppingItemDraft } from '@/lib/ai/tasks';
import { commitShoppingDrafts } from '@/lib/reality/shopping-lists';

interface ShoppingDraftConfirmProps {
  drafts: ShoppingItemDraft[];
  /** 已确认加入：卡片转为结果态，不再允许重复提交 */
  committed?: boolean;
  /** 用户编辑后的草稿回写给 ChatMessage，保持单一数据源 */
  onDraftsChange?: (drafts: ShoppingItemDraft[]) => void;
  onCommitted: () => void;
  onCancel: () => void;
  onNavigateToList: () => void;
}

/**
 * 采购草稿确认卡片。
 *
 * 数据契约：drafts 是采购信息的唯一事实来源。卡片自己不复述文案，
 * AI 的回复文本也不复述物品 —— 编辑只更新 drafts，界面自然同步，
 * 不存在「卡片改了、上面的话还是旧的」这种双源问题。
 */
export function ShoppingDraftConfirm({
  drafts,
  committed = false,
  onDraftsChange,
  onCommitted,
  onCancel,
  onNavigateToList
}: ShoppingDraftConfirmProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const budgetTotal = drafts.reduce((sum, item) => sum + (item.budget ?? 0), 0);

  // 编辑直接写回 ChatMessage.shoppingDrafts（单一数据源），
  // 卡片与后续确认都从 props 读取，不再维护第二份本地 state。
  const updateDraft = (index: number, patch: Partial<ShoppingItemDraft>) => {
    onDraftsChange?.(drafts.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  const removeDraft = (index: number) => {
    onDraftsChange?.(drafts.filter((_, i) => i !== index));
  };

  const handleConfirm = () => {
    if (drafts.length === 0) return;
    setSubmitting(true);
    setError(null);
    const added = commitShoppingDrafts(drafts);
    if (added.length > 0) {
      onCommitted();
    } else {
      setError('写入失败，请重试');
    }
    setSubmitting(false);
  };

  if (drafts.length === 0 && !committed) {
    return (
      <div className="mt-3 rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-900">
        没有识别到物品，请告诉我你想买什么。
      </div>
    );
  }

  if (committed) {
    return (
      <div className="mt-3 overflow-hidden rounded-lg border border-blue-100 bg-blue-50 p-3">
        <div className="min-w-0 text-sm text-blue-900">
          已加入采购清单 {drafts.length} 项
          {budgetTotal > 0 ? ` · 预算合计 ¥${budgetTotal}` : ''}
        </div>
        <ul className="mt-2 space-y-1">
          {drafts.map((item, idx) => (
            <li key={`${item.name}-${idx}`} className="min-w-0 break-words text-xs text-gray-600">
              ☑ {formatDraft(item)}
              {item.neededBy ? (
                <span className="text-gray-400"> · {item.neededBy}买</span>
              ) : null}
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={onNavigateToList}
          className="mt-2 w-full text-xs text-blue-700 hover:underline"
        >
          查看采购清单 →
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-blue-100 bg-blue-50 p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <span className="text-xs font-medium text-blue-900">准备加入采购清单</span>
        <span className="text-xs text-blue-700">
          {drafts.length} 项{budgetTotal > 0 ? ` · ¥${budgetTotal}` : ''}
        </span>
      </div>

      <ul className="space-y-2">
        {drafts.map((item, idx) => (
          <li
            key={`${item.name}-${idx}`}
            className="min-w-0 rounded border border-blue-100 bg-white p-2 text-sm"
          >
            {editing ? (
              /* 编辑态：纵向堆叠的带标签字段。不用绝对定位、不用固定列宽，
                 内容增多时卡片自然向下生长，宽度始终被 bubble 约束住。 */
              <div className="space-y-2">
                <Field label="物品">
                  <input
                    className={inputCls}
                    placeholder="要买什么"
                    value={item.name}
                    onChange={(e) => updateDraft(idx, { name: e.target.value })}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="数量">
                    <input
                      type="number"
                      min={0}
                      inputMode="decimal"
                      className={inputCls}
                      value={item.quantity ?? ''}
                      onChange={(e) =>
                        updateDraft(idx, {
                          quantity: e.target.value === '' ? undefined : Number(e.target.value)
                        })
                      }
                    />
                  </Field>
                  <Field label="单位">
                    <input
                      className={inputCls}
                      placeholder="包 / 箱"
                      value={item.unit ?? ''}
                      onChange={(e) => updateDraft(idx, { unit: e.target.value })}
                    />
                  </Field>
                </div>
                <Field label="计划什么时候买">
                  <input
                    className={inputCls}
                    placeholder="例：明天、这周末"
                    value={item.neededBy ?? ''}
                    onChange={(e) => updateDraft(idx, { neededBy: e.target.value })}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="预算（可选）">
                    <input
                      type="number"
                      min={0}
                      inputMode="decimal"
                      className={inputCls}
                      placeholder="元"
                      value={item.budget ?? ''}
                      onChange={(e) =>
                        updateDraft(idx, {
                          budget: e.target.value === '' ? undefined : Number(e.target.value)
                        })
                      }
                    />
                  </Field>
                  <Field label="备注（可选）">
                    <input
                      className={inputCls}
                      placeholder="牌子、规格…"
                      value={item.notes ?? ''}
                      onChange={(e) => updateDraft(idx, { notes: e.target.value })}
                    />
                  </Field>
                </div>
                <button
                  type="button"
                  onClick={() => removeDraft(idx)}
                  className="w-full py-1 text-xs text-red-500 hover:underline"
                >
                  移除这一项
                </button>
              </div>
            ) : (
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 break-words text-gray-900">{formatDraft(item)}</span>
                <div className="flex shrink-0 flex-col items-end gap-0.5">
                  {item.neededBy ? (
                    <span className="text-[11px] text-gray-500">{item.neededBy}买</span>
                  ) : null}
                  {item.budget != null ? (
                    <span className="text-[11px] text-gray-500">预算 ¥{item.budget}</span>
                  ) : null}
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={submitting || drafts.length === 0 || drafts.some((i) => !i.name.trim())}
          onClick={handleConfirm}
          className="min-w-0 flex-1 rounded-md bg-blue-500 py-2 text-sm text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          {submitting ? '处理中…' : '确认加入'}
        </button>
        <button
          type="button"
          disabled={submitting}
          onClick={() => setEditing((v) => !v)}
          className="shrink-0 rounded-md border border-blue-200 bg-white px-3 py-2 text-sm text-blue-700 hover:bg-blue-50 disabled:opacity-50"
        >
          {editing ? '收起' : '修改'}
        </button>
        <button
          type="button"
          disabled={submitting}
          onClick={onCancel}
          className="shrink-0 rounded-md px-3 py-2 text-sm text-gray-500 hover:text-gray-700 disabled:opacity-50"
        >
          取消
        </button>
      </div>

      {error ? <div className="mt-2 text-xs text-red-600">{error}</div> : null}
    </div>
  );
}

const inputCls = 'min-w-0 w-full rounded border border-gray-200 bg-white px-2 py-1 text-sm';

/**
 * 带标签的字段容器。标签常驻（不是 placeholder 独占），
 * 用户一眼能分清哪个框是数量、哪个是预算，不必靠猜。
 */
function Field({
  label,
  children
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-0.5 block text-[11px] leading-tight text-gray-500">{label}</span>
      {children}
    </label>
  );
}

function formatDraft(item: ShoppingItemDraft): string {
  const qty = item.quantity != null ? `${item.quantity}${item.unit ?? ''}` : '';
  return qty ? `${item.name} × ${qty}` : item.name;
}