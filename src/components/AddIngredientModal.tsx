'use client';

import { useEffect, useRef, useState } from 'react';
import {
  InventoryIngredient,
  KITCHEN_STORAGE_LOCATIONS,
  UNSPECIFIED_STORAGE_LABEL
} from '@/lib/types/ingredient';

interface AddIngredientModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddIngredient: (ingredient: Omit<InventoryIngredient, 'id' | 'createdAt'>) => void;
  /**
   * 传入即编辑模式：打开时按这条记录填充表单；不传为新增模式，沿用下方默认值。
   * Modal 不区分保存语义：两种模式都走同一个 onAddIngredient，由调用方决定落库入口。
   */
  initialValue?: InventoryIngredient;
}

/** 新增模式的默认表单（与原行内初始值逐字段一致） */
const DEFAULT_FORM = {
  name: '',
  quantity: '',
  unit: '',
  category: '蔬菜',
  purchaseDate: '',
  expiryDate: '',
  // 位置默认未指定：用户没选就等于系统替他决定放哪儿，而厨房不止冰箱一处 ——
  // 猜错的行既进不了正确分组，也再没人会去改。
  storageLocation: ''
};

export default function AddIngredientModal({ isOpen, onClose, onAddIngredient, initialValue }: AddIngredientModalProps) {
  // hooks 必须在条件返回之前调用：编辑模式需要每次打开时重置表单，早退得挪到 hooks 之后。
  const [formData, setFormData] = useState(DEFAULT_FORM);
  const isEditMode = !!initialValue;

  // 始终持有最新的 initialValue，但 effect 只依赖 isOpen：只在「打开」这一刻填充表单，
  // 父组件每次重渲染（哪怕传入新的对象身份）都不会覆盖用户正在输入的内容。
  const initialValueRef = useRef(initialValue);
  initialValueRef.current = initialValue;

  useEffect(() => {
    if (!isOpen) return;
    const value = initialValueRef.current;
    setFormData(
      value
        ? {
            name: value.name,
            quantity: value.quantity,
            unit: value.unit,
            category: value.category,
            purchaseDate: value.purchaseDate,
            expiryDate: value.expiryDate,
            storageLocation: value.storageLocation
          }
        : DEFAULT_FORM
    );
  }, [isOpen]);

  if (!isOpen) return null;

  const categories = ['蔬菜', '肉类', '水果', '奶制品', '主食', '调味品', '饮料', '其他'];
  // 选项由类型层的联合类型派生，与 Parser 认的储存区域同一套口径：
  // 词表以后加区域，表单不会漏项。「未指定」的 value 是空串而不是「未指定」——
  // 那个字面量永远不该出现在现实数据里，它只是空值的显示文案。
  const storageLocationOptions: { label: string; value: string }[] = [
    { label: UNSPECIFIED_STORAGE_LABEL, value: '' },
    ...KITCHEN_STORAGE_LOCATIONS.map((location) => ({ label: location, value: location }))
  ];

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onAddIngredient(formData); // 调用父组件传递的回调函数（新增 / 编辑共用，落库由调用方决定）
    setFormData(DEFAULT_FORM); // 清空表单，回到与初次打开一致的默认值（位置同样是未指定）
    onClose(); // 关闭模态框
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-bold text-gray-900">
              {isEditMode ? '编辑食材' : '添加食材'}
            </h2>
            <button 
              onClick={onClose}
              className="text-gray-500 hover:text-gray-700"
            >
              ✕
            </button>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  食材名称 *
                </label>
                <input
                  type="text"
                  name="name"
                  value={formData.name}
                  onChange={handleChange}
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="例如：鸡蛋、牛奶"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    数量
                  </label>
                  <input
                    type="number"
                    name="quantity"
                    value={formData.quantity}
                    onChange={handleChange}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="数量"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    单位
                  </label>
                  <input
                    type="text"
                    name="unit"
                    value={formData.unit}
                    onChange={handleChange}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="例如：个、升、克"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  分类
                </label>
                <select
                  name="category"
                  value={formData.category}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {categories.map(category => (
                    <option key={category} value={category}>{category}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  购买日期
                </label>
                <input
                  type="date"
                  name="purchaseDate"
                  value={formData.purchaseDate}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  过期日期
                </label>
                <input
                  type="date"
                  name="expiryDate"
                  value={formData.expiryDate}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  保存位置
                </label>
                <select
                  name="storageLocation"
                  value={formData.storageLocation}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {storageLocationOptions.map(option => (
                    <option key={`storage-${option.value}`} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mt-6 flex space-x-3">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
              >
                取消
              </button>
              <button
                type="submit"
                className="flex-1 px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600"
              >
                {isEditMode ? '保存' : '添加'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}