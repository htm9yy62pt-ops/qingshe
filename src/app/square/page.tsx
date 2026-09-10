'use client';

import { useState } from 'react';
import Link from 'next/link';
import { SearchIcon, PlusIcon, MessageIcon, HeartIcon, CommentIcon } from '@/components/icons';

type SquareTabId = 'discover' | 'mine';

const TABS: { id: SquareTabId; label: string }[] = [
  { id: 'discover', label: '推荐' },
  { id: 'mine', label: '我的' }
];

const POSTS = [
  {
    id: 1,
    type: '轻舍方案',
    title: '冰箱里剩下的牛肉和豌豆怎么处理？',
    content: '利用现有食材做了一份豌豆炒牛肉，只补买了少量调料。',
    likes: 24,
    comments: 8
  },
  {
    id: 2,
    type: '生活经验',
    title: '一个人住以后，我不再囤纸巾',
    content: '记录自己的真实消耗速度之后，发现以前经常重复购买。',
    likes: 42,
    comments: 15
  },
  {
    id: 3,
    type: '家居',
    title: '39 元解决出租屋厨房收纳问题',
    content: '用几个简单的收纳盒整理了厨房台面，空间利用率提升明显。',
    likes: 31,
    comments: 6
  },
  {
    id: 4,
    type: '省钱',
    title: '这次搬家我少花了 800 元',
    content: '提前规划和比价，找到了性价比更高的搬家公司，还避免了临时加价。',
    likes: 56,
    comments: 21
  },
  {
    id: 5,
    type: '轻舍方案',
    title: '周末懒人早餐，10分钟搞定',
    content: '只需要面包、鸡蛋和水果，营养搭配均衡，制作简单。',
    likes: 38,
    comments: 12
  },
  {
    id: 6,
    type: '生活经验',
    title: '我发现了一个记账的小窍门',
    content: '用手机拍照记录每天的支出，月底统计时一目了然。',
    likes: 27,
    comments: 5
  }
];

export default function SquarePage() {
  return <SquareContent />;
}

function SquareContent() {
  const [activeTab, setActiveTab] = useState<SquareTabId>('discover');

  return (
    <div className="flex flex-col min-h-screen">
      <main className="flex-1 bg-gray-50 pb-16">
        <div className="max-w-md mx-auto">
          {/* Header */}
          <div className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between sticky top-0 z-10">
            <h1 className="text-xl font-bold text-gray-900">广场</h1>
            <div className="flex space-x-3">
              <button className="p-2 rounded-full hover:bg-gray-100">
                <MessageIcon className="h-5 w-5 text-gray-600" />
              </button>
              <button className="p-2 rounded-full hover:bg-gray-100">
                <SearchIcon className="h-5 w-5 text-gray-600" />
              </button>
              <button className="p-2 rounded-full bg-blue-500 text-white">
                <PlusIcon className="h-5 w-5" />
              </button>
            </div>
          </div>

          {/* Content Tabs：必须真正可点击并切换内容 */}
          <div className="bg-white border-b border-gray-200 px-4 py-3 sticky top-[57px] z-10">
            <div className="flex space-x-6">
              {TABS.map((tab) => {
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    aria-pressed={isActive}
                    className={`pb-2 px-1 ${
                      isActive
                        ? 'text-blue-600 border-b-2 border-blue-600 font-medium'
                        : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 内容区：根据 activeTab 条件渲染 */}
          {activeTab === 'discover' ? (
            <div className="grid grid-cols-2 gap-3 p-3">
              {POSTS.map((post) => (
                <div
                  key={post.id}
                  className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden"
                >
                  <div
                    className={`h-32 ${
                      post.type === '轻舍方案'
                        ? 'bg-gradient-to-r from-green-100 to-emerald-100'
                        : 'bg-gradient-to-r from-blue-100 to-indigo-100'
                    } flex items-center justify-center`}
                  >
                    <span className="text-gray-500 text-sm">内容封面</span>
                  </div>

                  <div className="p-3">
                    <div className="mb-2">
                      {post.type === '轻舍方案' ? (
                        <span className="inline-block px-2 py-1 bg-green-100 text-green-800 text-xs rounded-md border border-green-200">
                          {post.type}
                        </span>
                      ) : (
                        <span className="inline-block px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded-md">
                          {post.type}
                        </span>
                      )}
                    </div>

                    <h2 className="text-sm font-semibold text-gray-900 mb-1 line-clamp-2">
                      {post.title}
                    </h2>
                    <p className="text-xs text-gray-600 line-clamp-2 mb-2">
                      {post.content}
                    </p>

                    <div className="flex space-x-3 text-gray-500 text-xs">
                      <div className="flex items-center space-x-1">
                        <HeartIcon className="h-3 w-3" />
                        <span>{post.likes}</span>
                      </div>
                      <div className="flex items-center space-x-1">
                        <CommentIcon className="h-3 w-3" />
                        <span>{post.comments}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-3 pb-6">
              <h2 className="text-sm font-medium text-gray-500 mb-3 px-1">我的</h2>
              <Link href="/life-records">
                <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-200 cursor-pointer hover:shadow-md transition-shadow">
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="text-base font-semibold text-gray-900 mb-1">
                        我的轻舍方案
                      </h2>
                      <p className="text-gray-500 text-sm">
                        记录你真实完成过的生活方案
                      </p>
                    </div>
                    <span className="text-gray-400">→</span>
                  </div>
                </div>
              </Link>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}