'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Recipe } from '@/lib/types/recipe';
import { QINGSCHE_RECIPES } from '@/lib/knowledge';

const MY_RECIPES_KEY = 'qingshe_my_recipes';

const difficultyMap: Record<string, string> = {
  easy: '简单',
  medium: '中等',
  hard: '较难'
};

export default function RecipesPage() {
  const [activeTab, setActiveTab] = useState<'official' | 'mine'>('official');
  const [myRecipes, setMyRecipes] = useState<Recipe[]>([]);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);

  // 加载我的菜谱
  useEffect(() => {
    const stored = localStorage.getItem(MY_RECIPES_KEY);
    if (stored) {
      try {
        const parsed: Recipe[] = JSON.parse(stored).map((r: any) => ({
          ...r,
          createdAt: new Date(r.createdAt),
          updatedAt: new Date(r.updatedAt)
        }));
        setMyRecipes(parsed);
      } catch (e) {
        console.error('Failed to parse my recipes:', e);
      }
    }
  }, []);

  // 保存我的菜谱到 localStorage
  const saveMyRecipes = (recipes: Recipe[]) => {
    try {
      localStorage.setItem(MY_RECIPES_KEY, JSON.stringify(recipes));
    } catch (e) {
      console.error('Failed to save my recipes:', e);
    }
  };

  const handleAddRecipe = (newRecipe: Recipe) => {
    const updated = [...myRecipes, newRecipe];
    setMyRecipes(updated);
    saveMyRecipes(updated);
    setIsAddModalOpen(false);
  };

  return (
    <div className="flex flex-col min-h-screen">
      <main className="flex-1 bg-gray-50 pb-16">
        <div className="max-w-md mx-auto px-4 pt-12">
          {/* 顶部导航 */}
          <div className="flex items-center mb-6">
            <Link
              href="/reality"
              className="text-gray-600 hover:text-gray-900 mr-4"
            >
              ← 返回
            </Link>
            <h1 className="text-2xl font-bold">菜谱</h1>
          </div>

          {/* Tab 切换 */}
          <div className="flex justify-between mb-6 bg-gray-100 rounded-lg p-1">
            <button
              className={`flex-1 py-2 px-4 rounded-md text-center ${activeTab === 'official' ? 'bg-white shadow-sm' : ''}`}
              onClick={() => setActiveTab('official')}
            >
              轻舍菜谱
            </button>
            <button
              className={`flex-1 py-2 px-4 rounded-md text-center ${activeTab === 'mine' ? 'bg-white shadow-sm' : ''}`}
              onClick={() => setActiveTab('mine')}
            >
              我的菜谱
            </button>
          </div>

          {/* 轻舍菜谱 */}
          {activeTab === 'official' && (
            <div className="space-y-4">
              {QINGSCHE_RECIPES.map((recipe) => (
                <div
                  key={recipe.id}
                  className="bg-white rounded-xl p-4 shadow-sm border border-gray-200"
                >
                  {/* 封面占位 */}
                  <div className="w-full h-40 bg-gray-100 rounded-lg mb-4 flex items-center justify-center">
                    <span className="text-4xl">🍳</span>
                  </div>

                  <h2 className="text-xl font-bold text-gray-900 mb-2">
                    {recipe.title}
                  </h2>

                  <p className="text-gray-600 text-sm mb-3">
                    {recipe.description}
                  </p>

                  <div className="flex items-center gap-4 text-sm text-gray-500 mb-3">
                    <span>⏱ {recipe.estimatedTime}分钟</span>
                    <span>难度：{difficultyMap[recipe.difficulty]}</span>
                  </div>

                  <div className="flex flex-wrap gap-2 mb-3">
                    {recipe.tags.map((tag) => (
                      <span
                        key={tag}
                        className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>

                  <div className="border-t border-gray-100 pt-3">
                    <p className="text-sm text-gray-600 mb-1">主要食材：</p>
                    <p className="text-sm text-gray-800">
                      {recipe.ingredients
                        .filter((i) => i.required)
                        .map((i) => i.name)
                        .join('、')}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 我的菜谱 */}
          {activeTab === 'mine' && (
            <div>
              {myRecipes.length === 0 ? (
                <div className="text-center py-12 bg-white rounded-xl shadow-sm border border-gray-200">
                  <div className="text-4xl mb-4">📖</div>
                  <h3 className="text-lg font-medium text-gray-900 mb-2">
                    还没有我的菜谱
                  </h3>
                  <p className="text-gray-600 mb-6 px-4">
                    把你常做、喜欢的菜保存下来，轻舍会在合适的时候想起它。
                  </p>
                  <button
                    onClick={() => setIsAddModalOpen(true)}
                    className="px-6 py-3 bg-blue-500 text-white rounded-lg font-medium hover:bg-blue-600"
                  >
                    添加我的菜谱
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  {myRecipes.map((recipe) => (
                    <div
                      key={recipe.id}
                      className="bg-white rounded-xl p-4 shadow-sm border border-gray-200"
                    >
                      <div className="w-full h-32 bg-gray-100 rounded-lg mb-3 flex items-center justify-center">
                        <span className="text-3xl">🍽️</span>
                      </div>
                      <h2 className="text-lg font-bold text-gray-900 mb-1">
                        {recipe.title}
                      </h2>
                      <p className="text-gray-600 text-sm mb-2">
                        {recipe.description}
                      </p>
                      <div className="flex items-center gap-3 text-sm text-gray-500">
                        <span>⏱ {recipe.estimatedTime}分钟</span>
                        <span>难度：{difficultyMap[recipe.difficulty]}</span>
                      </div>
                    </div>
                  ))}

                  <button
                    onClick={() => setIsAddModalOpen(true)}
                    className="w-full py-3 border border-dashed border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50 flex items-center justify-center"
                  >
                    + 添加我的菜谱
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {/* 添加我的菜谱模态框 */}
      {isAddModalOpen && (
        <AddRecipeModal
          onClose={() => setIsAddModalOpen(false)}
          onAdd={handleAddRecipe}
        />
      )}
    </div>
  );
}

interface AddRecipeModalProps {
  onClose: () => void;
  onAdd: (recipe: Recipe) => void;
}

function AddRecipeModal({ onClose, onAdd }: AddRecipeModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('家常菜');
  const [estimatedTime, setEstimatedTime] = useState(15);
  const [difficulty, setDifficulty] = useState<'easy' | 'medium' | 'hard'>('easy');
  const [ingredientsText, setIngredientsText] = useState('');
  const [stepsText, setStepsText] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const ingredients: { name: string; required: boolean }[] = ingredientsText
      .split(/[，,、\n]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((name) => ({ name, required: true }));

    const steps: { step: number; content: string }[] = stepsText
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((content, index) => ({ step: index + 1, content }));

    const now = new Date();
    const newRecipe: Recipe = {
      id: `my_recipe_${Date.now()}`,
      title: title.trim() || '未命名菜谱',
      description: description.trim(),
      category: category.trim(),
      ingredients,
      optionalIngredients: [],
      steps,
      estimatedTime,
      difficulty,
      tags: ['我的菜谱'],
      sourceType: 'user',
      createdAt: now,
      updatedAt: now
    };

    onAdd(newRecipe);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-md max-h-[90vh] overflow-y-auto p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold">添加我的菜谱</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 text-2xl"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              菜名
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="例如：妈妈的红烧肉"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              简短描述
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="一句话描述这道菜"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              分类
            </label>
            <input
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="flex gap-4">
            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                预计时间（分钟）
              </label>
              <input
                type="number"
                min={1}
                value={estimatedTime}
                onChange={(e) => setEstimatedTime(Number(e.target.value))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                难度
              </label>
              <select
                value={difficulty}
                onChange={(e) => setDifficulty(e.target.value as 'easy' | 'medium' | 'hard')}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="easy">简单</option>
                <option value="medium">中等</option>
                <option value="hard">较难</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              主要食材
            </label>
            <textarea
              value={ingredientsText}
              onChange={(e) => setIngredientsText(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              rows={3}
              placeholder="每行一个食材，例如：&#10;猪肉&#10;土豆&#10;生抽"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              步骤
            </label>
            <textarea
              value={stepsText}
              onChange={(e) => setStepsText(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              rows={4}
              placeholder="每行一个步骤"
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-3 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
            >
              取消
            </button>
            <button
              type="submit"
              className="flex-1 py-3 bg-blue-500 text-white rounded-lg font-medium hover:bg-blue-600"
            >
              保存
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}