'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { LifeResource } from '@/lib/types/life-resource';
import {
  getLifeResources,
  addLifeResource,
  updateLifeResource,
  deleteLifeResource,
  toggleFavoriteLifeResource
} from '@/lib/reality/life-resources';
import { LifeResourceFormModal } from '@/components/LifeResourceFormModal';

const TYPE_LABEL: Record<LifeResource['type'], string> = {
  supermarket: '超市',
  market: '菜市场',
  online_store: '网店',
  local_store: '本地店铺',
  other: '其他'
};

export default function LifeResourcesPage() {
  const [resources, setResources] = useState<LifeResource[]>([]);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingResource, setEditingResource] = useState<LifeResource | null>(null);

  useEffect(() => {
    setResources(getLifeResources());
  }, []);

  const favoriteResources = resources.filter((r) => r.isFavorite);
  const otherResources = resources.filter((r) => !r.isFavorite);

  const handleSave = (resource: LifeResource) => {
    if (editingResource) {
      setResources((prev) => updateLifeResource(prev, resource));
    } else {
      setResources((prev) => addLifeResource(prev, resource));
    }
    setIsFormOpen(false);
    setEditingResource(null);
  };

  const handleEdit = (resource: LifeResource) => {
    setEditingResource(resource);
    setIsFormOpen(true);
  };

  const handleDelete = (id: string) => {
    if (window.confirm('确定要删除这个好店吗？删除后无法恢复。')) {
      setResources((prev) => deleteLifeResource(prev, id));
    }
  };

  const handleToggleFavorite = (id: string) => {
    setResources((prev) => toggleFavoriteLifeResource(prev, id));
  };

  const handleAdd = () => {
    setEditingResource(null);
    setIsFormOpen(true);
  };

  const renderResourceCard = (resource: LifeResource) => (
    <div
      key={resource.id}
      className="bg-white rounded-xl p-5 shadow-sm border border-gray-200"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-gray-900 truncate">
              {resource.name}
            </h2>
            {resource.isFavorite && <span className="text-yellow-500">⭐</span>}
          </div>
          <p className="text-xs text-gray-500 mt-1">{TYPE_LABEL[resource.type]}</p>
          {resource.description && (
            <p className="text-sm text-gray-700 mt-2">{resource.description}</p>
          )}
          {resource.address && (
            <p className="text-sm text-gray-500 mt-1">📍 {resource.address}</p>
          )}
          {resource.url && (
            <a
              href={resource.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-500 hover:underline mt-1 inline-block"
            >
              打开链接
            </a>
          )}
          {resource.tags && resource.tags.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-3">
              {resource.tags.map((tag) => (
                <span
                  key={tag}
                  className="px-2 py-1 bg-gray-100 text-gray-600 rounded-md text-xs"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="flex gap-2 mt-4 pt-3 border-t border-gray-100">
        <button
          type="button"
          onClick={() => handleToggleFavorite(resource.id)}
          className="text-sm px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
        >
          {resource.isFavorite ? '取消收藏' : '收藏'}
        </button>
        <button
          type="button"
          onClick={() => handleEdit(resource)}
          className="text-sm px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
        >
          编辑
        </button>
        <button
          type="button"
          onClick={() => handleDelete(resource.id)}
          className="text-sm ml-auto px-3 py-1.5 rounded-lg text-red-500 hover:text-red-700 hover:bg-red-50"
        >
          删除
        </button>
      </div>
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
            <h1 className="text-3xl font-bold">我的好店</h1>
          </div>
          <p className="text-gray-700 mb-6">
            保存你常用、信任的购买渠道。
            <br />
            以后轻舍在你需要购买东西时，可以优先考虑这些选择。
          </p>

          <button
            type="button"
            onClick={handleAdd}
            className="w-full mb-6 py-3 bg-blue-500 text-white rounded-xl font-medium hover:bg-blue-600"
          >
            + 添加我的好店
          </button>

          {resources.length === 0 ? (
            <div className="bg-white rounded-xl p-8 shadow-sm border border-gray-200 text-center">
              <div className="text-4xl mb-3">🏪</div>
              <h2 className="text-lg font-medium text-gray-900 mb-2">还没有我的好店</h2>
              <p className="text-gray-600 text-sm">
                把你常去的超市、菜市场、网店等保存下来，方便以后使用。
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {favoriteResources.length > 0 && (
                <div className="space-y-4">
                  <h2 className="text-sm font-medium text-gray-500">收藏/常用</h2>
                  {favoriteResources.map(renderResourceCard)}
                </div>
              )}
              {otherResources.length > 0 && (
                <div className="space-y-4">
                  {favoriteResources.length > 0 && (
                    <h2 className="text-sm font-medium text-gray-500">我的好店</h2>
                  )}
                  {otherResources.map(renderResourceCard)}
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {isFormOpen && (
        <LifeResourceFormModal
          resource={editingResource}
          onSave={handleSave}
          onClose={() => {
            setIsFormOpen(false);
            setEditingResource(null);
          }}
        />
      )}
    </div>
  );
}