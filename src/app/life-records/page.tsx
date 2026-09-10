'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { LifeRecordDraft } from '@/lib/types/life-record';
import {
  loadLifeRecords,
  updateLifeRecord,
  deleteLifeRecord
} from '@/lib/reality/life-records';
import { LifeRecordDetailModal } from '@/components/LifeRecordDetailModal';

const TYPE_ICON: Record<string, string> = {
  cooking: '🍳'
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

export default function LifeRecordsPage() {
  const [records, setRecords] = useState<LifeRecordDraft[]>([]);
  const [selectedRecord, setSelectedRecord] = useState<LifeRecordDraft | null>(null);

  useEffect(() => {
    setRecords(loadLifeRecords());
  }, []);

  const savedRecords = useMemo(
    () => records.filter((record) => record.status === 'saved'),
    [records]
  );

  const sortedRecords = useMemo(
    () =>
      [...savedRecords].sort(
        (a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime()
      ),
    [savedRecords]
  );

  const handleSave = (updated: LifeRecordDraft) => {
    const nextRecords = updateLifeRecord(updated);
    setRecords(nextRecords);
    setSelectedRecord(updated);
  };

  const handleDelete = (id: string) => {
    const nextRecords = deleteLifeRecord(id);
    setRecords(nextRecords);
    setSelectedRecord(null);
  };

  return (
    <div className="flex flex-col min-h-screen">
      <main className="flex-1 bg-gray-50 pb-16">
        <div className="max-w-md mx-auto px-4 pt-12">
          <div className="flex items-center gap-2 mb-2">
            <Link href="/reality" className="text-gray-500 hover:text-gray-700">
              ← 家
            </Link>
            <h1 className="text-3xl font-bold">我的轻舍方案</h1>
          </div>
          <p className="text-gray-700 mb-6">记录你真实完成过的生活方案</p>

          {sortedRecords.length === 0 ? (
            <div className="bg-white rounded-xl p-8 shadow-sm border border-gray-200 text-center">
              <div className="text-4xl mb-3">🌱</div>
              <h2 className="text-lg font-medium text-gray-900 mb-2">
                还没有保存的轻舍方案
              </h2>
              <p className="text-gray-600 text-sm leading-relaxed">
                完成一次真实生活行动后，
                <br />
                你可以把它保存成属于自己的轻舍方案。
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {sortedRecords.map((record) => (
                <button
                  key={record.id}
                  type="button"
                  onClick={() => setSelectedRecord(record)}
                  className="w-full text-left bg-white rounded-xl p-5 shadow-sm border border-gray-200 hover:shadow-md transition-shadow"
                >
                  <div className="flex items-start gap-3">
                    <span className="text-2xl">{TYPE_ICON[record.type] ?? '📝'}</span>
                    <div className="flex-1 min-w-0">
                      <h2 className="text-base font-semibold text-gray-900 truncate">
                        {record.title}
                      </h2>
                      <p className="text-sm text-gray-500 mt-1">
                        {formatDate(record.completedAt)} · {record.visibility === 'private' ? '私密' : '公开'}
                      </p>
                      <p className="text-sm text-gray-700 mt-2 line-clamp-2">
                        {record.summary}
                      </p>
                      {record.usedIngredients.length > 0 && (
                        <p className="text-xs text-gray-500 mt-2">
                          使用：{record.usedIngredients.map((item) => item.name).join(' · ')}
                        </p>
                      )}
                    </div>
                    <span className="text-gray-400">→</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </main>

      {selectedRecord && (
        <LifeRecordDetailModal
          record={selectedRecord}
          onClose={() => setSelectedRecord(null)}
          onSave={handleSave}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}