'use client';

import { useState } from 'react';
import { LifeRecordDraft } from '@/lib/types/life-record';

interface LifeRecordDraftConfirmProps {
  draft: LifeRecordDraft;
  onSave: (draft: LifeRecordDraft) => void;
  onDiscard: () => void;
}

export function LifeRecordDraftConfirm({
  draft,
  onSave,
  onDiscard
}: LifeRecordDraftConfirmProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(draft.title);
  const [summary, setSummary] = useState(draft.summary);
  const [saved, setSaved] = useState(false);

  const usedNames = draft.usedIngredients.map((item) => item.name);

  const handleSave = () => {
    onSave({
      ...draft,
      title: title.trim() || draft.title,
      summary: summary.trim() || draft.summary,
      status: 'saved'
    });
    setSaved(true);
    setIsEditing(false);
  };

  if (saved) {
    return (
      <div className="mt-4">
        <div className="bg-green-50 rounded-lg p-4 text-sm text-green-800">
          <p className="font-medium">已保存到你的轻舍方案</p>
          <p className="mt-1">这条记录目前是私密的，不会自动发布到广场。</p>
        </div>
        <div className="mt-4 flex gap-3">
          <button
            type="button"
            onClick={onDiscard}
            className="flex-1 py-3 bg-blue-500 text-white rounded-lg font-medium hover:bg-blue-600"
          >
            完成
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4">
      <div className="bg-green-50 rounded-lg p-4 text-center">
        <div className="text-2xl mb-1">🎉</div>
        <p className="text-sm font-medium text-green-900">制作完成</p>
      </div>

      <div className="mt-4 space-y-3">
        <div>
          <h4 className="text-xs font-medium text-gray-500 mb-1">今天你完成了</h4>
          {isEditing ? (
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-200"
            />
          ) : (
            <p className="text-base font-semibold text-gray-900">{title}</p>
          )}
        </div>

        <div>
          <h4 className="text-xs font-medium text-gray-500 mb-1">实际使用</h4>
          <p className="text-sm text-gray-700">
            {usedNames.length > 0 ? usedNames.join('、') : '未记录真实消耗食材'}
          </p>
        </div>

        <div>
          <h4 className="text-xs font-medium text-gray-500 mb-1">生成一条生活记录</h4>
          {isEditing ? (
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-200"
            />
          ) : (
            <p className="text-sm text-gray-700 bg-gray-50 rounded-lg p-3 leading-relaxed">
              {summary}
            </p>
          )}
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleSave}
          className="px-4 py-2 rounded-lg bg-green-500 text-white hover:bg-green-600"
        >
          保存我的轻舍方案
        </button>
        <button
          type="button"
          onClick={() => setIsEditing((v) => !v)}
          className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
        >
          {isEditing ? '完成编辑' : '编辑'}
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className="ml-auto px-4 py-2 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100"
        >
          暂时不保存
        </button>
      </div>
    </div>
  );
}