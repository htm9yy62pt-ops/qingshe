'use client';

/**
 * 「建立我的生活」—— 轻舍第一次和用户打照面的浮层。
 *
 * 它是宿主，不是数据层：一步一句话，话交给 lib/onboarding/flow 变成草稿，
 * 草稿交给现有确认卡（IngredientConfirmCard / ConsumableDraftConfirm）过目，
 * 用户点确认才由 Reality 层写进真实的冰箱和消耗品账本。
 * 自己既没有食材表，也没有消耗品表，连「怎么解析」都不 copy 一份。
 */

import { useRef, useState } from 'react';
import AddIngredientModal from '@/components/AddIngredientModal';
import { IngredientConfirmCard } from '@/components/IngredientConfirmCard';
import { ConsumableDraftConfirm } from '@/components/ConsumableDraftConfirm';
import type { ConsumableDraft } from '@/lib/ai/tasks';
import type { IngredientRecordDraft } from '@/lib/ai/record';
import type { InventoryIngredient } from '@/lib/types/ingredient';
import {
  advanceStep,
  commitFridgeDrafts,
  commitFridgeRecords,
  createConfirmLatch,
  readConsumablesInput,
  readFridgeInput,
  stepProgress,
} from '@/lib/onboarding/flow';
import type { ConfirmLatch, OnboardingStep } from '@/lib/onboarding/flow';
import { markOnboardingDone, markOnboardingSkipped } from '@/lib/onboarding/state';

interface BuildLifeOnboardingProps {
  /** 走完或提前离开：宿主收起浮层，并重新读一遍现实数据 */
  onFinished: () => void;
}

export function BuildLifeOnboarding({ onFinished }: BuildLifeOnboardingProps) {
  const [step, setStep] = useState<OnboardingStep>('welcome');
  const [words, setWords] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const [fridgeDrafts, setFridgeDrafts] = useState<IngredientRecordDraft[]>([]);
  const [consumableDrafts, setConsumableDrafts] = useState<ConsumableDraft[]>([]);
  const [manualAddOpen, setManualAddOpen] = useState(false);
  const [told, setTold] = useState({ fridge: 0, consumables: 0 });
  /** 每个确认卡各一把门闩：一次确认只落一次盘（快速双击、事件重放都拦在这里） */
  const latches = useRef<Partial<Record<string, ConfirmLatch>>>({});

  const latchFor = (key: string): ConfirmLatch => {
    let latch = latches.current[key];
    if (!latch) {
      latch = createConfirmLatch();
      latches.current[key] = latch;
    }
    return latch;
  };

  /** 换新的一轮话就换一把门闩，别让上一张卡的锁误伤这一张 */
  const resetLatch = (key: string) => {
    delete latches.current[key];
  };

  const goNext = () => {
    setHint(null);
    setWords('');
    setStep(advanceStep(step));
  };

  // ── 第一步：冰箱 ────────────────────────────────────────────
  const readFridgeWords = () => {
    const result = readFridgeInput(words);
    if (!result.ok) {
      setHint(result.hint);
      return;
    }
    resetLatch('fridge');
    setFridgeDrafts(result.drafts);
    setHint(null);
    setWords('');
  };

  const confirmFridge = () => {
    const drafts = fridgeDrafts;
    const outcome = latchFor('fridge').run(() => commitFridgeDrafts(drafts));
    if (!outcome.ok) return; // 已经写过一次：不再落第二笔
    setTold(prev => ({ ...prev, fridge: outcome.value.added }));
    setFridgeDrafts([]);
    goNext();
  };

  const addFridgeByHand = (record: Omit<InventoryIngredient, 'id' | 'createdAt'>) => {
    commitFridgeRecords([record]);
    setManualAddOpen(false);
  };

  // ── 第二步：消耗品 ──────────────────────────────────────────
  const readConsumableWords = () => {
    const result = readConsumablesInput(words);
    if (!result.ok) {
      setHint(result.hint);
      return;
    }
    setConsumableDrafts(result.drafts);
    setHint(null);
    setWords('');
  };

  const leave = (mark: 'done' | 'skipped') => {
    if (mark === 'done') markOnboardingDone();
    else markOnboardingSkipped();
    onFinished();
  };

  const progress = stepProgress(step);

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-white"
      role="dialog"
      aria-modal="true"
      aria-label="建立我的生活"
    >
      <div className="mx-auto flex min-h-full w-full max-w-md flex-col px-5 pb-12 pt-10">
        <p className="text-xs tracking-[0.2em] text-stone-400">轻舍 · 建立我的生活</p>
        {progress && <p className="text-xs text-stone-400">{progress}</p>}

        {step === 'welcome' && (
          <section className="mt-8 flex flex-1 flex-col justify-center">
            <h1 className="text-2xl font-semibold text-stone-800">欢迎来到轻舍</h1>
            <p className="mt-4 whitespace-pre-line text-sm leading-7 text-stone-500">
              {'先告诉我一点你的生活，\n我会慢慢认识你。'}
            </p>
            <div className="mt-10 space-y-3">
              <button
                onClick={() => setStep(advanceStep('welcome'))}
                className="w-full rounded-xl bg-emerald-600 px-4 py-3 text-sm font-medium text-white"
              >
                开始建立
              </button>
              <button
                onClick={() => leave('skipped')}
                className="w-full rounded-xl border border-stone-200 px-4 py-3 text-sm text-stone-500"
              >
                暂时跳过
              </button>
            </div>
          </section>
        )}

        {step === 'fridge' && (
          <section className="mt-8">
            <h2 className="text-xl font-semibold text-stone-800">冰箱里有什么？</h2>
            <p className="mt-3 whitespace-pre-line text-sm leading-7 text-stone-500">
              {'先告诉我你现在手边有哪些食材。\n不用记得很详细，想到什么告诉我什么就好。'}
            </p>

            {fridgeDrafts.length > 0 ? (
              <div className="mt-6">
                <IngredientConfirmCard
                  drafts={fridgeDrafts}
                  onConfirm={confirmFridge}
                  onRemove={index => setFridgeDrafts(list => list.filter((_, i) => i !== index))}
                  onCancel={() => setFridgeDrafts([])}
                />
              </div>
            ) : (
              <>
                <textarea
                  value={words}
                  onChange={e => setWords(e.target.value)}
                  rows={3}
                  placeholder={'牛肉、鸡蛋、西红柿、洋葱、豌豆\n也可以说：我冰箱里现在有牛肉、鸡蛋和西红柿'}
                  className="mt-6 w-full resize-none rounded-xl border border-stone-200 px-4 py-3 text-sm text-stone-700 outline-none focus:border-emerald-500"
                />
                {hint && <p className="mt-2 text-xs leading-5 text-amber-600">{hint}</p>}
                <button
                  onClick={readFridgeWords}
                  className="mt-3 w-full rounded-xl bg-emerald-600 px-4 py-3 text-sm font-medium text-white"
                >
                  让轻舍看一下
                </button>
                <button
                  onClick={() => setManualAddOpen(true)}
                  className="mt-2 w-full rounded-xl border border-stone-200 px-4 py-3 text-sm text-stone-500"
                >
                  也可以一个一个添加
                </button>
              </>
            )}

            <button onClick={goNext} className="mt-6 w-full py-2 text-sm text-stone-400">
              暂时跳过
            </button>
          </section>
        )}

        {step === 'consumables' && (
          <section className="mt-8">
            <h2 className="text-xl font-semibold text-stone-800">家里有哪些常用消耗品？</h2>
            <p className="mt-3 whitespace-pre-line text-sm leading-7 text-stone-500">
              {'比如纸巾、垃圾袋、洗衣液、洗洁精。\n以后快用完了，我也可以帮你记着。'}
            </p>

            {consumableDrafts.length > 0 ? (
              <div className="mt-6">
                <ConsumableDraftConfirm
                  drafts={consumableDrafts}
                  onDraftsChange={setConsumableDrafts}
                  committed={false}
                  onCommitted={() => {
                    setTold(prev => ({ ...prev, consumables: consumableDrafts.length }));
                    setConsumableDrafts([]);
                    goNext();
                  }}
                  onCancel={() => setConsumableDrafts([])}
                  onNavigateToList={onFinished}
                />
              </div>
            ) : (
              <>
                <textarea
                  value={words}
                  onChange={e => setWords(e.target.value)}
                  rows={3}
                  placeholder={'纸巾、垃圾袋、洗衣液、洗洁精\n也可以说：我家里一般会备纸巾和垃圾袋'}
                  className="mt-6 w-full resize-none rounded-xl border border-stone-200 px-4 py-3 text-sm text-stone-700 outline-none focus:border-emerald-500"
                />
                {hint && <p className="mt-2 text-xs leading-5 text-amber-600">{hint}</p>}
                <button
                  onClick={readConsumableWords}
                  className="mt-3 w-full rounded-xl bg-emerald-600 px-4 py-3 text-sm font-medium text-white"
                >
                  让轻舍看一下
                </button>
              </>
            )}

            <button onClick={goNext} className="mt-6 w-full py-2 text-sm text-stone-400">
              暂时跳过
            </button>
          </section>
        )}

        {step === 'completion' && (
          <section className="mt-8 flex flex-1 flex-col justify-center">
            <h2 className="text-xl font-semibold text-stone-800">刚认识你的时候，我什么都不知道。</h2>
            <p className="mt-3 text-sm leading-7 text-stone-500">
              {told.fridge > 0 || told.consumables > 0
                ? `这次你告诉我：冰箱里 ${told.fridge} 样，家里常备消耗品 ${told.consumables} 件。`
                : '这次你没留下什么，也没关系。'}
            </p>
            <p className="mt-6 whitespace-pre-line text-sm leading-7 text-stone-600">
              {ONBOARDING_GROWTH_COPY}
            </p>
            <p className="mt-6 text-sm leading-7 text-emerald-700">
              {'告诉我更多你的生活，\n我就能更好地陪伴你。'}
            </p>
            <button
              onClick={() => leave('done')}
              className="mt-10 w-full rounded-xl bg-emerald-600 px-4 py-3 text-sm font-medium text-white"
            >
              开始使用轻舍
            </button>
          </section>
        )}
      </div>

      {/* 手动添加复用现有表单：条件挂载，不让它和 isOpen 的早期 return 抢 hooks 顺序 */}
      {manualAddOpen && (
        <AddIngredientModal
          isOpen
          onClose={() => setManualAddOpen(false)}
          onAddIngredient={addFridgeByHand}
        />
      )}
    </div>
  );
}

/** 「养成系」的表达：这次只做表达，菜谱/店铺/习惯都不提前实现 */
const ONBOARDING_GROWTH_COPY = [
  '以后，你也可以随时告诉我：',
  '喜欢做的菜、',
  '常去的店铺、',
  '常买的东西、',
  '家里已经有什么、',
  '喜欢什么、不喜欢什么，',
  '还有你的生活习惯。',
  '',
  '不用一次全部告诉我。',
  '你生活到哪里，',
  '就告诉我到哪里。',
  '我会慢慢认识你的生活。',
].join('\n');