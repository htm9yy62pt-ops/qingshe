'use client';

import { useEffect, useState } from 'react';
import type {
  AddShoppingItemDraft,
  AddShoppingItemsInput
} from '@/lib/reality/shopping-lists';

interface ShoppingItemFormModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: AddShoppingItemsInput) => void;
}

/**
 * 手动添加采购物品的最小表单。
 *
 * MVP：
 * - 必填：物品名称
 * - 推荐：数量 / 单位 / 什么时候需要
 * - 可选：预算 / 提醒时间 / 备注
 *
 * 不强制要求所有字段，提交始终允许（只要 name 非空）。
 */
export function ShoppingItemFormModal({
  open,
  onClose,
  onSubmit
}: ShoppingItemFormModalProps) {
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState('');
  const [neededBy, setNeededBy] = useState('');
  const [budget, setBudget] = useState('');
  const [remindAt, setRemindAt] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 打开时清空状态
  useEffect(() => {
    if (open) {
      setName('');
      setQuantity('');
      setUnit('');
      setNeededBy('');
      setBudget('');
      setRemindAt('');
      setNotes('');
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('请填写物品名称');
      return;
    }
    if (submitting) return;
    setSubmitting(true);

    const draft: AddShoppingItemDraft = {
      name: trimmedName
    };

    const q = quantity.trim();
    if (q) {
      const n = Number(q);
      draft.quantity = Number.isFinite(n) ? n : q;
    }
    if (unit.trim()) draft.unit = unit.trim();
    if (neededBy.trim()) draft.neededBy = neededBy.trim();
    if (budget.trim()) {
      const b = Number(budget);
      if (Number.isFinite(b)) draft.budget = b;
    }
    if (remindAt.trim()) draft.remindAt = remindAt.trim();
    if (notes.trim()) draft.notes = notes.trim();

    try {
      onSubmit({ items: [draft], source: 'manual' });
      onClose();
    } catch (e) {
      console.error('Failed to submit shopping item:', e);
      setError('提交失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-2xl w-full max-w-md max-h-[90vh] overflow-y-auto shadow-xl">
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-lg font-bold text-gray-900">添加采购物品</h2>
            <button
              type="button"
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
              aria-label="关闭"
            >
              ×
            </button>
          </div>

          {error && (
            <div className="text-sm text-red-600 bg-red-50 rounded p-2">
              {error}
            </div>
          )}

          {/* 必填：物品名称 */}
          <div>
            <label className="text-xs text-gray-600">
              物品名称 <span className="text-red-500">*</span>
            </label>
            <input
              autoFocus
              className="mt-1 w-full border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="例如：纸巾"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {/* 推荐：数量 / 单位 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-600">数量</label>
              <input
                type="number"
                className="mt-1 w-full border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="1"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs text-gray-600">单位</label>
              <input
                className="mt-1 w-full border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="包 / 瓶 / 个"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
              />
            </div>
          </div>

          {/* 推荐：什么时候需要 */}
          <div>
            <label className="text-xs text-gray-600">什么时候需要</label>
            <input
              className="mt-1 w-full border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="今天 / 明天 / 本周末"
              value={neededBy}
              onChange={(e) => setNeededBy(e.target.value)}
            />
          </div>

          {/* 可选：预算 / 提醒时间 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-600">预算</label>
              <input
                type="number"
                className="mt-1 w-full border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="0"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs text-gray-600">提醒时间</label>
              <input
                className="mt-1 w-full border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="明天 18:00"
                value={remindAt}
                onChange={(e) => setRemindAt(e.target.value)}
              />
            </div>
          </div>

          {/* 可选：备注 */}
          <div>
            <label className="text-xs text-gray-600">备注</label>
            <textarea
              className="mt-1 w-full border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="例如：低敏感配方"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <div className="flex gap-2 pt-2">
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 py-2.5 bg-blue-500 text-white text-sm rounded-md hover:bg-blue-600 disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              {submitting ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2.5 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
            >
              取消
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}