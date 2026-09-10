'use client';

import { useState } from 'react';
import { LifeRecordDraft } from '@/lib/types/life-record';

interface LifeRecordDetailModalProps {
  record: LifeRecordDraft;
  onClose: () => void;
  onSave: (record: LifeRecordDraft) => void;
  onDelete: (id: string) => void;
}

const TYPE_ICON: Record<string, string> = {
  cooking: '🍳'
};

const TYPE_LABEL: Record<string, string> = {
  cooking: '烹饪'
};

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

export function LifeRecordDetailModal({
  record,
  onClose,
  onSave,
  onDelete
}: LifeRecordDetailModalProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(record.title);
  const [summary, setSummary] = useState(record.summary);

  const handleSave = () => {
    onSave({
      ...record,
      title: title.trim() || record.title,
      summary: summary.trim() || record.summary
    });
    setIsEditing(false);
  };

  const handleDelete = () => {
    if (window.confirm('确定要删除这条生活记录吗？删除后无法恢复。')) {
      onDelete(record.id);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-2xl w-full max-w-md max-h-[85vh] overflow-y-auto shadow-xl">
        <div className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-2xl">{TYPE_ICON[record.type] ?? '📝'}</span>
              <div>
                <h2 className="text-xl font-bold text-gray-900">
                  {isEditing ? (
                    <input
                      type="text"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      className="w-full px-2 py-1 text-base border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-200"
                    />
                  ) : (
                    record.title
                  )}
                </h2>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
              aria-label="关闭"
            >
              ×
            </button>
          </div>

          <div className="mt-4 space-y-4 text-sm">
            <div className="flex items-center gap-2 text-gray-500">
              <span className="px-2 py-1 bg-gray-100 rounded-md">
                {TYPE_LABEL[record.type] ?? record.type}
              </span>
              {record.visibility === 'private' && (
                <span className="px-2 py-1 bg-gray-100 rounded-md">私密</span>
              )}
            </div>

            <div>
              <h3 className="text-xs font-medium text-gray-500 mb-1">完成时间</h3>
              <p className="text-gray-900">{formatDateTime(record.completedAt)}</p>
            </div>

            <div>
              <h3 className="text-xs font-medium text-gray-500 mb-1">记录内容</h3>
              {isEditing ? (
                <textarea
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  rows={4}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-200"
                />
              ) : (
                <p className="text-gray-700 leading-relaxed bg-gray-50 rounded-lg p-3">
                  {record.summary}
                </p>
              )}
            </div>

            <div>
              <h3 className="text-xs font-medium text-gray-500 mb-1">实际使用</h3>
              {record.usedIngredients.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {record.usedIngredients.map((item) => (
                    <span
                      key={item.name}
                      className="px-2 py-1 bg-blue-50 text-blue-800 rounded-md text-xs"
                    >
                      {item.name}
                      {item.actualQuantity != null &&
                        ` · ${item.actualQuantity}${item.unit ?? ''}`}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-gray-500">未记录真实消耗食材</p>
              )}
            </div>

            <div>
              <h3 className="text-xs font-medium text-gray-500 mb-1">保存时间</h3>
              <p className="text-gray-500">{formatDateTime(record.createdAt)}</p>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap gap-2">
            {isEditing ? (
              <button
                type="button"
                onClick={handleSave}
                className="px-4 py-2 rounded-lg bg-green-500 text-white hover:bg-green-600"
              >
                保存修改
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setIsEditing(true)}
                className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
              >
                编辑
              </button>
            )}

            {isEditing && (
              <button
                type="button"
                onClick={() => {
                  setIsEditing(false);
                  setTitle(record.title);
                  setSummary(record.summary);
                }}
                className="px-4 py-2 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100"
              >
                取消
              </button>
            )}

            <button
              type="button"
              onClick={handleDelete}
              className="ml-auto px-4 py-2 rounded-lg text-red-500 hover:text-red-700 hover:bg-red-50"
            >
              删除
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}