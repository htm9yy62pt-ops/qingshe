'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import AddIngredientModal from '@/components/AddIngredientModal';
import { InventoryIngredient } from '@/lib/types/ingredient';
import { Reminder, ReminderType } from '@/lib/types/reminder';
import { loadIngredients, saveIngredients, groupIngredientsByStorage, updateIngredient } from '@/lib/reality/ingredients';
import { loadReminders } from '@/lib/reality/reminders';
import { getDueReminders } from '@/lib/reality/reminder-engine';

const REMINDER_KIND_LABEL: Record<ReminderType, string> = {
  normal: '单次',
  recurring: '定期',
  reality_check: '复查',
  replenishment: '补货'
};

/** 有周期的提醒类型：展示间隔，其余只展示时间点 */
const INTERVAL_KINDS: ReminderType[] = ['recurring', 'reality_check', 'replenishment'];

// 获取当前日期的字符串格式
const getCurrentDateString = (): string => {
  const now = new Date();
  return now.toISOString().split('T')[0];
};

// 格式化日期显示：模块级纯函数，库存行组件与页面头部都要读日期
const formatDate = (dateString: string): string => {
  if (!dateString) return '';
  const date = new Date(dateString);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
};

// 判断食材状态
const getIngredientStatus = (expiryDate: string): 'normal' | 'expiring' | 'expired' => {
  if (!expiryDate) return 'normal';
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(expiryDate);
  expiry.setHours(0, 0, 0, 0);
  
  const diffTime = expiry.getTime() - today.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  if (diffDays < 0) {
    return 'expired';
  } else if (diffDays <= 3) {
    return 'expiring';
  } else {
    return 'normal';
  }
};

// 从 localStorage 加载食材数据
// 已迁移至 src/lib/reality/ingredients.ts 的 loadIngredients。

// 保存食材数据到 localStorage
// 已迁移至 src/lib/reality/ingredients.ts 的 saveIngredients。

/**
 * 厨房库存的一行。
 *
 * 储存位置由所在的分组标题说明，行内不再重复一遍 —— 未指定的行以前会渲染成
 * 「蔬菜 · 」这种悬空分隔符，位置是空还是没存根本看不出来。
 */
function IngredientRow({
  ingredient,
  onDelete,
  onEdit
}: {
  ingredient: InventoryIngredient;
  onDelete: (id: string) => void;
  onEdit: (ingredient: InventoryIngredient) => void;
}) {
  const status = getIngredientStatus(ingredient.expiryDate);
  let statusClass = '';
  let statusText = '';

  if (status === 'expiring') {
    statusClass = 'bg-orange-100 text-orange-800';
    statusText = '临期';
  } else if (status === 'expired') {
    statusClass = 'bg-red-100 text-red-800';
    statusText = '已过期';
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 relative">
      {status !== 'normal' && (
        <span className={`absolute top-2 right-2 text-xs px-2 py-1 rounded-full ${statusClass}`}>
          {statusText}
        </span>
      )}

      <div className="flex justify-between items-start">
        <div>
          <h3 className="font-semibold text-gray-900">{ingredient.name}</h3>
          <p className="text-gray-600 mt-1">
            {ingredient.quantity} {ingredient.unit}
          </p>
          {ingredient.category && (
            <p className="text-sm text-gray-500 mt-2">{ingredient.category}</p>
          )}
          {ingredient.expiryDate && (
            <p className="text-sm text-gray-500 mt-1">
              {formatDate(ingredient.expiryDate)} 到期
            </p>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => onEdit(ingredient)}
            className="text-gray-400 hover:text-blue-500"
            aria-label="编辑食材"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path d="m5.433 13.917 1.262-3.155A4 4 0 0 1 7.58 9.42l6.92-6.918a2.121 2.121 0 0 1 3 3l-6.92 6.918c-.383.383-.84.685-1.343.886l-3.154 1.262a.5.5 0 0 1-.65-.65z" />
              <path d="M3.5 5.75c0-.69.56-1.25 1.25-1.25H10A.75.75 0 0 0 10 3H4.75A2.75 2.75 0 0 0 2 5.75v9.5A2.75 2.75 0 0 0 4.75 18h9.5A2.75 2.75 0 0 0 17 15.25V10a.75.75 0 0 0-1.5 0v5.25c0 .69-.56 1.25-1.25 1.25h-9.5c-.69 0-1.25-.56-1.25-1.25v-9.5z" />
            </svg>
          </button>
          <button
            onClick={() => onDelete(ingredient.id)}
            className="text-gray-400 hover:text-red-500"
            aria-label="删除食材"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

export default function RealityPage() {
  const [activeTab, setActiveTab] = useState<'home' | 'outside' | 'reminders'>('home');
  const [ingredients, setIngredients] = useState<InventoryIngredient[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  /** 当前编辑中的食材：null = 新增模式，非空 = 编辑模式（Modal 以 initialValue 填充） */
  const [editingIngredient, setEditingIngredient] = useState<InventoryIngredient | null>(null);

  // 页面加载时从 localStorage 加载数据
  useEffect(() => {
    const loadedIngredients = loadIngredients();
    setIngredients(loadedIngredients);
    setReminders(loadReminders().filter((reminder) => reminder.status === 'active'));
    // 首页「提醒事项」入口用 ?tab=reminders 直达；读 location 而不是 useSearchParams，
    // 后者会把这个纯静态页拖成动态渲染。
    const tab = new URLSearchParams(window.location.search).get('tab');
    if (tab === 'reminders' || tab === 'outside' || tab === 'home') {
      setActiveTab(tab);
    }
  }, []);

  // 到期判定复用 reminder-engine，页面不自己写一套时间比较
  const dueReminderIds = useMemo(
    () => new Set(getDueReminders(reminders).map((reminder) => reminder.id)),
    [reminders]
  );

  // 计算统计数据
  const ingredientsCount = ingredients.length;
  const expiringIngredientsCount = ingredients.filter(
    ingredient => getIngredientStatus(ingredient.expiryDate) === 'expiring'
  ).length;

  // 库存列表按储存位置分组（冷藏/冷冻/橱柜/常温/其他/未指定），空组不显示。
  // 只是同一份 storageLocation 的另一种读法：CRUD、字段形状、统计口径都不变。
  const kitchenGroups = groupIngredientsByStorage(ingredients);

  const handleAddIngredient = () => {
    // 新增入口必须清空编辑态，否则 Modal 会拿着上一条记录进入编辑模式
    setEditingIngredient(null);
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setEditingIngredient(null);
  };

  /**
   * 编辑入口：记住当前编辑的食材，由 Modal 按 initialValue 填充表单。
   * 提交动作在 handleIngredientSubmit 里按本状态区分新增 / 编辑。
   */
  const handleEditIngredient = (ingredient: InventoryIngredient) => {
    setEditingIngredient(ingredient);
    setIsModalOpen(true);
  };

  // 添加新食材
  const addNewIngredient = (ingredientData: Omit<InventoryIngredient, 'id' | 'createdAt'>) => {
    const newIngredient: InventoryIngredient = {
      ...ingredientData,
      id: `ingredient_${Date.now()}`, // 简单的 ID 生成
      createdAt: getCurrentDateString(),
    };

    const updatedIngredients = [...ingredients, newIngredient];
    setIngredients(updatedIngredients);
    saveIngredients(updatedIngredients);
  };

  /**
   * 保存编辑：写基线必须现读 localStorage（loadIngredients），不能用页面 state ——
   * Modal 打开期间别的入口改过的库存不在页面快照里，拿旧快照当基线会覆盖掉那些变化。
   * updateIngredient 按 id 更新，找不到 id 时原样返回、绝不追加新记录。
   */
  const saveEditedIngredient = (ingredientData: Omit<InventoryIngredient, 'id' | 'createdAt'>) => {
    if (!editingIngredient) return;
    const latest = loadIngredients();
    const updated = updateIngredient(latest, editingIngredient.id, ingredientData);
    setIngredients(updated);
  };

  /**
   * Modal 的统一提交入口：两种模式共用同一个回调（Modal 不区分保存语义），
   * 这里按 editingIngredient 分流到新增或编辑的落库逻辑。
   */
  const handleIngredientSubmit = (ingredientData: Omit<InventoryIngredient, 'id' | 'createdAt'>) => {
    if (editingIngredient) {
      saveEditedIngredient(ingredientData);
    } else {
      addNewIngredient(ingredientData);
    }
  };

  // 删除食材
  const deleteIngredient = (id: string) => {
    const updatedIngredients = ingredients.filter(ingredient => ingredient.id !== id);
    setIngredients(updatedIngredients);
    saveIngredients(updatedIngredients);
  };

  /** 提醒的调度描述：周期提醒说清间隔，单次提醒说清时间点 */
  const describeReminder = (reminder: Reminder): string => {
    const at = reminder.nextTriggerAt || reminder.remindAt;
    const when = at ? formatDate(at) : '未安排时间';
    return INTERVAL_KINDS.includes(reminder.type)
      ? `${when} · 每 ${reminder.intervalDays ?? '?'} 天`
      : when;
  };

  return (
    <div className="flex flex-col min-h-screen">
      <main className="flex-1 bg-gray-50 pb-16">
        <div className="max-w-md mx-auto px-4 pt-12">
          <h1 className="text-3xl font-bold mb-2">家</h1>
          <p className="text-gray-700 mb-6">记录你真实拥有的生活资源</p>
          
          {/* Tab 切换 */}
          <div className="flex justify-between mb-6 bg-gray-100 rounded-lg p-1">
            <button 
              className={`flex-1 py-2 px-4 rounded-md text-center ${activeTab === 'home' ? 'bg-white shadow-sm' : ''}`}
              onClick={() => setActiveTab('home')}
            >
              家里
            </button>
            <button 
              className={`flex-1 py-2 px-4 rounded-md text-center ${activeTab === 'outside' ? 'bg-white shadow-sm' : ''}`}
              onClick={() => setActiveTab('outside')}
            >
              家外
            </button>
            <button 
              className={`flex-1 py-2 px-4 rounded-md text-center ${activeTab === 'reminders' ? 'bg-white shadow-sm' : ''}`}
              onClick={() => setActiveTab('reminders')}
            >
              提醒
            </button>
          </div>

          {/* 家里区域 */}
          {activeTab === 'home' && (
            <div className="space-y-6">
              {/* 我的厨房 - 核心功能 */}
              <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-200">
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h2 className="text-xl font-bold text-gray-900">我的厨房</h2>
                    <p className="text-gray-600 text-sm mt-1">看看家里还有什么，减少浪费和重复购买</p>
                  </div>
                </div>
                
                {/* 厨房概览卡片 */}
                <div className="bg-blue-50 rounded-lg p-4 mb-4">
                  <div className="flex justify-between">
                    <div>
                      <p className="text-gray-600 text-sm">食材数量</p>
                      <p className="text-lg font-semibold text-gray-900">{ingredientsCount}</p>
                    </div>
                    <div>
                      <p className="text-gray-600 text-sm">临期食材</p>
                      <p className="text-lg font-semibold text-gray-900">{expiringIngredientsCount}</p>
                    </div>
                  </div>
                </div>
                
                {/* 空状态或内容 */}
                {ingredientsCount === 0 ? (
                  <div className="text-center py-8">
                    <h3 className="text-lg font-medium text-gray-900 mb-2">厨房还是空的</h3>
                    <p className="text-gray-600 mb-6">记录家里的食材，让轻舍帮你减少浪费，看看还能做什么。</p>
                    <button
                      onClick={handleAddIngredient}
                      className="px-6 py-3 bg-blue-500 text-white rounded-lg font-medium hover:bg-blue-600"
                    >
                      添加第一样食材
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <button
                      onClick={handleAddIngredient}
                      className="w-full py-3 border border-dashed border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50 flex items-center justify-center"
                    >
                      + 添加食材
                    </button>
                    
                    {/* 我的厨房：按储存位置分组，只有有数据的组才出现 */}
                    <div className="space-y-6 mt-4">
                      {kitchenGroups.map((group) => (
                        <div key={group.location ?? 'unspecified'}>
                          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                            {group.label}
                          </h4>
                          <div className="space-y-3 mt-2">
                            {group.items.map((ingredient) => (
                              <IngredientRow
                                key={ingredient.id}
                                ingredient={ingredient}
                                onDelete={deleteIngredient}
                                onEdit={handleEditIngredient}
                              />
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              
              {/* 菜谱 */}
              <Link href="/recipes">
                <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-200 cursor-pointer hover:shadow-md transition-shadow">
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="text-lg font-medium text-gray-900 mb-1">菜谱</h2>
                      <p className="text-gray-500 text-sm">轻舍菜谱和我的菜谱</p>
                    </div>
                    <span className="text-gray-400">→</span>
                  </div>
                </div>
              </Link>

              {/* 消耗品 */}
              <Link href="/consumables">
                <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-200 cursor-pointer hover:shadow-md transition-shadow">
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="text-lg font-medium text-gray-900 mb-1">消耗品</h2>
                      <p className="text-gray-500 text-sm">纸巾、洗衣液等日用品余量</p>
                    </div>
                    <span className="text-gray-400">→</span>
                  </div>
                </div>
              </Link>
            </div>
          )}

          {/* 家外区域 */}
          {activeTab === 'outside' && (
            <div className="space-y-6">
              {/* 我的好店 */}
              <Link href="/life-resources">
                <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-200 cursor-pointer hover:shadow-md transition-shadow">
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="text-lg font-medium text-gray-900 mb-1">我的好店</h2>
                      <p className="text-gray-500 text-sm">保存你常用、信任的购买渠道</p>
                    </div>
                    <span className="text-gray-400">→</span>
                  </div>
                </div>
              </Link>
            </div>
          )}

          {/* 提醒区域 */}
          {activeTab === 'reminders' && (
            <div className="space-y-6">
              {/* 采购清单 */}
              <Link href="/shopping-list">
                <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-200 cursor-pointer hover:shadow-md transition-shadow">
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="text-lg font-medium text-gray-900 mb-1">采购清单</h2>
                      <p className="text-gray-500 text-sm">为菜谱和生活方案准备的待购清单</p>
                    </div>
                    <span className="text-gray-400">→</span>
                  </div>
                </div>
              </Link>
              <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-200">
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h2 className="text-xl font-bold text-gray-900">提醒事项</h2>
                    <p className="text-gray-600 text-sm mt-1">记录重要事项，不错过生活中的重要节点</p>
                  </div>
                </div>
                
                {/* 空状态：提醒由 AI 对话与消耗品复查自动建立 */}
                {reminders.length === 0 && (
                  <div className="text-center py-8">
                    <h3 className="text-lg font-medium text-gray-900 mb-2">还没有提醒事项</h3>
                    <p className="text-gray-600">
                      在 AI 对话里说「记得提醒我交房租」，或添加一件消耗品，
                      系统会自动建立复查提醒。
                    </p>
                  </div>
                )}
                
                {/* 真实提醒列表：qingshe_reminders 是唯一来源 */}
                {reminders.length > 0 && (
                  <div className="mt-6 space-y-3">
                    {reminders.map((reminder) => (
                      <div key={reminder.id} className="bg-gray-50 rounded-lg p-4">
                        <div className="flex justify-between items-center">
                          <div>
                            <h3 className="font-medium text-gray-900">{reminder.title}</h3>
                            <p className="text-sm text-gray-500">{describeReminder(reminder)}</p>
                          </div>
                          <div className="flex items-center gap-2">
                            {dueReminderIds.has(reminder.id) && (
                              <span className="text-xs bg-red-100 text-red-800 px-2 py-1 rounded">
                                已到期
                              </span>
                            )}
                            <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">
                              {REMINDER_KIND_LABEL[reminder.type]}
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        
        {/* 添加食材模态框 */}
        <AddIngredientModal 
          isOpen={isModalOpen} 
          onClose={handleCloseModal} 
          onAddIngredient={handleIngredientSubmit}
          initialValue={editingIngredient ?? undefined}
        />
      </main>
    </div>
  );
}