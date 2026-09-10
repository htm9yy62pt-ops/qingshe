'use client';

import { useState } from 'react';
import type { ConsumableDraft } from '@/lib/ai/tasks';
import { commitConsumables } from '@/lib/reality/consumable-commit';

interface Props {
  /** 唯一数据源：ChatMessage.consumableDrafts，编辑直接回写父组件 */
  drafts: ConsumableDraft[];
  onDraftsChange: (next: ConsumableDraft[]) => void;
  /** 已确认：卡片转为结果态，不消失 */
  committed: boolean;
  onCommitted: () => void;
  onCancel: () => void;
  onNavigateToList: () => void;
}

export function ConsumableDraftConfirm({
  drafts,
  onDraftsChange,
  committed,
  onCommitted,
  onCancel,
  onNavigateToList
}: Props) {
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // 确认时算一次，供结果态如实回显「建了几条提醒」
  const [reminderCount, setReminderCount] = useState(0);

  const updateDraft = (idx: number, patch: Partial<ConsumableDraft>) => {
    onDraftsChange(drafts.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
  };

  const removeDraft = (idx: number) => {
    onDraftsChange(drafts.filter((_, i) => i !== idx));
  };

  const handleConfirm = () => {
    if (submitting || drafts.length === 0) return;
    setSubmitting(true);
    try {
      // 消耗品与提醒一起落地：只写消耗品等于登记了一条永远不会开口的静态记录。
      // 这段编排住在 commitConsumables 里，聊天里打「确认」走的是同一个函数。
      const { reminderCount: created } = commitConsumables(drafts);
      setReminderCount(created);
      onCommitted();
    } catch (e) {
      console.error('Failed to commit consumable draft:', e);
    } finally {
      setSubmitting(false);
    }
  };

  if (committed) {
    return (
      <div className="mt-3 bg-amber-50 rounded-lg p-3 border border-amber-100">
        <div className="text-sm text-amber-900">
          已登记 {drafts.length} 项家中物品
          {reminderCount > 0 ? ` · 建立 ${reminderCount} 条提醒` : ''}
        </div>
        <ul className="mt-2 space-y-1">
          {drafts.map((item, idx) => (
            <li key={`${item.name}-${idx}`} className="text-xs text-gray-600">
              ✓ {formatDraft(item)}
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={onNavigateToList}
          className="mt-2 w-full text-xs text-amber-700 hover:underline"
        >
          查看家中物品 →
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3 bg-amber-50 rounded-lg p-3 border border-amber-100">
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <span className="text-xs font-medium text-amber-900">准备记为家中物品</span>
        <span className="text-xs text-amber-700 shrink-0">{drafts.length} 项</span>
      </div>

      <ul className="space-y-2">
        {drafts.map((item, idx) => (
          <li
            key={`${item.name}-${idx}`}
            className="bg-white rounded p-2 text-sm border border-amber-100 min-w-0"
          >
            {editing ? (
              <div className="space-y-2 min-w-0">
                <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_3.5rem] gap-2">
                  <input
                    className="min-w-0 w-full border rounded px-2 py-1 text-sm"
                    placeholder="物品名称"
                    value={item.name}
                    onChange={(e) => updateDraft(idx, { name: e.target.value })}
                  />
                  <input
                    type="number"
                    min={0}
                    className="min-w-0 w-full border rounded px-2 py-1 text-sm"
                    placeholder="数量"
                    value={item.quantity ?? ''}
                    onChange={(e) =>
                      updateDraft(idx, {
                        quantity: e.target.value === '' ? undefined : Number(e.target.value)
                      })
                    }
                  />
                  <input
                    className="min-w-0 w-full border rounded px-2 py-1 text-sm"
                    placeholder="单位"
                    value={item.unit ?? ''}
                    onChange={(e) => updateDraft(idx, { unit: e.target.value })}
                  />
                </div>
                <div className="grid grid-cols-[minmax(0,1fr)_6rem_2rem] gap-2">
                  <input
                    className="min-w-0 w-full border rounded px-2 py-1 text-sm"
                    placeholder="放在哪里"
                    value={item.location ?? ''}
                    onChange={(e) => updateDraft(idx, { location: e.target.value })}
                  />
                  <input
                    type="number"
                    min={1}
                    className="min-w-0 w-full border rounded px-2 py-1 text-sm"
                    placeholder="提醒间隔"
                    value={item.checkIntervalDays ?? ''}
                    onChange={(e) =>
                      updateDraft(idx, {
                        checkIntervalDays:
                          e.target.value === '' ? undefined : Number(e.target.value)
                      })
                    }
                  />
                  <button
                    type="button"
                    aria-label={`移除${item.name}`}
                    onClick={() => removeDraft(idx)}
                    className="w-full border border-amber-200 rounded text-amber-500 hover:bg-amber-50 leading-none"
                  >
                    ×
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-amber-600 shrink-0">✓</span>
                <span className="text-gray-900 truncate">{formatDraft(item)}</span>
              </div>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={submitting || drafts.length === 0 || drafts.some((d) => !d.name.trim())}
          onClick={handleConfirm}
          className="flex-1 min-w-0 py-2 bg-amber-500 text-white text-sm rounded-md hover:bg-amber-600 disabled:bg-gray-300 disabled:cursor-not-allowed"
        >
          {submitting ? '处理中…' : '确认记录'}
        </button>
        <button
          type="button"
          disabled={submitting}
          onClick={() => setEditing((v) => !v)}
          className="shrink-0 px-3 py-2 text-sm text-amber-700 bg-white border border-amber-200 rounded-md hover:bg-amber-50 disabled:opacity-50"
        >
          {editing ? '完成编辑' : '修改'}
        </button>
        <button
          type="button"
          disabled={submitting}
          onClick={onCancel}
          className="shrink-0 px-3 py-2 text-sm text-gray-600 bg-white border border-gray-200 rounded-md hover:bg-gray-50 disabled:opacity-50"
        >
          取消
        </button>
      </div>
    </div>
  );
}

function formatDraft(item: ConsumableDraft): string {
  const qty = item.quantity != null ? `×${item.quantity}${item.unit ?? ''}` : '';
  const parts = [`${item.name}${qty}`];
  if (item.location) parts.push(`放在${item.location}`);
  if (item.estimatedRunOutDays != null)
    parts.push(`大概 ${item.estimatedRunOutDays} 天用完`);
  else if (item.checkIntervalDays != null)
    parts.push(`${item.checkIntervalDays} 天提醒一次`);
  return parts.join('，');
}