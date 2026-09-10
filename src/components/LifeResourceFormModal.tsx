'use client';

import { useState, useEffect } from 'react';
import { LifeResource, LifeResourceType } from '@/lib/types/life-resource';

const TYPE_OPTIONS: { value: LifeResourceType; label: string }[] = [
  { value: 'supermarket', label: '超市' },
  { value: 'market', label: '菜市场' },
  { value: 'online_store', label: '网店' },
  { value: 'local_store', label: '本地店铺' },
  { value: 'other', label: '其他' }
];

const QUICK_TAGS = [
  '蔬菜',
  '水果',
  '肉类',
  '海鲜',
  '调料',
  '米面粮油',
  '零食',
  '饮料',
  '日用品',
  '清洁用品'
];

interface LifeResourceFormModalProps {
  resource?: LifeResource | null;
  onSave: (resource: LifeResource) => void;
  onClose: () => void;
}

/**
 * 内部统一维护 selectedTags 数组。
 * - 来自快捷标签点击
 * - 来自用户手动输入（逗号/空格分隔）
 * 提交时去重 + trim。
 */
function parseTagsInput(input: string): string[] {
  return input
    .split(/[\s,，]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function LifeResourceFormModal({
  resource,
  onSave,
  onClose
}: LifeResourceFormModalProps) {
  const [name, setName] = useState('');
  const [type, setType] = useState<LifeResourceType>('local_store');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [description, setDescription] = useState('');
  const [address, setAddress] = useState('');
  const [url, setUrl] = useState('');

  useEffect(() => {
    if (resource) {
      setName(resource.name);
      setType(resource.type);
      setSelectedTags(resource.tags ?? []);
      setTagInput('');
      setDescription(resource.description ?? '');
      setAddress(resource.address ?? '');
      setUrl(resource.url ?? '');
    } else {
      setName('');
      setType('local_store');
      setSelectedTags([]);
      setTagInput('');
      setDescription('');
      setAddress('');
      setUrl('');
    }
  }, [resource]);

  const toggleQuickTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;

    const manualTags = parseTagsInput(tagInput);
    const merged = Array.from(
      new Set([...selectedTags, ...manualTags].map((t) => t.trim()).filter(Boolean))
    );

    if (resource) {
      onSave({
        ...resource,
        name: trimmedName,
        type,
        tags: merged.length > 0 ? merged : undefined,
        description: description.trim() || undefined,
        address: address.trim() || undefined,
        url: url.trim() || undefined,
        updatedAt: new Date().toISOString()
      });
    } else {
      const newResource: LifeResource = {
        id: `life_resource_${Date.now()}`,
        name: trimmedName,
        type,
        tags: merged.length > 0 ? merged : undefined,
        description: description.trim() || undefined,
        address: address.trim() || undefined,
        url: url.trim() || undefined,
        isFavorite: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      onSave(newResource);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-2xl w-full max-w-md max-h-[85vh] overflow-y-auto shadow-xl">
        <div className="p-5">
          <div className="flex items-start justify-between gap-3 mb-4">
            <h2 className="text-xl font-bold text-gray-900">
              {resource ? '编辑好店' : '添加我的好店'}
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
              aria-label="关闭"
            >
              ×
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            {/* 必填：店铺名称 */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                店铺名称 <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：盒马鲜生"
                required
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-200"
              />
            </div>

            {/* 必填：类型 */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                类型 <span className="text-red-500">*</span>
              </label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as LifeResourceType)}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-200 bg-white"
              >
                {TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            {/* 推荐填写：我通常在这里买什么 */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                我通常在这里买什么
              </label>
              <p className="text-xs text-gray-500 mb-2">
                填写你通常会在这家店购买的东西，轻舍会根据采购清单优先推荐合适的店。
              </p>

              <div className="flex flex-wrap gap-2 mb-2">
                {QUICK_TAGS.map((tag) => {
                  const selected = selectedTags.includes(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => toggleQuickTag(tag)}
                      className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                        selected
                          ? 'bg-blue-500 text-white border-blue-500'
                          : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      {tag}
                    </button>
                  );
                })}
              </div>

              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                placeholder="也可用逗号分隔手动输入，例如：米面粮油、日用品、清洁用品"
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-200"
              />
              {selectedTags.length > 0 && (
                <p className="text-xs text-gray-500 mt-1">
                  已选：{selectedTags.join('、')}
                </p>
              )}
            </div>

            {/* 可选信息分组 */}
            <div className="border-t border-gray-100 pt-4 space-y-4">
              <p className="text-xs text-gray-500">其他信息（可选）</p>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  备注
                </label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="例如：蔬菜水果很新鲜"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-200"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  地址
                </label>
                <input
                  type="text"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="例如：小区东门对面"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-200"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  链接
                </label>
                <input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="例如：https://example.com/shop"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-200"
                />
              </div>
            </div>

            <div className="flex gap-3 pt-2">
              <button
                type="submit"
                className="flex-1 py-3 bg-blue-500 text-white rounded-lg font-medium hover:bg-blue-600"
              >
                {resource ? '保存修改' : '添加'}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-3 border border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-50"
              >
                取消
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}