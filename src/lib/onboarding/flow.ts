/**
 * 「建立我的生活」流程契约：步骤、话→草稿、确认落盘、防重复写入。
 *
 * 这里不存放舍的任何生活数据模型，全部向外借：
 * - 冰箱话 → 草稿：P0.5-1 已验收的 tryParseInventoryRecords / tryParseInventoryRecord + buildIngredientDraft
 * - 消耗品话 → 草稿：现有 extractInitialConsumableDrafts
 * - 落盘：Reality 层的唯一写入者 commitIngredients / commitConsumables
 * - 「这句算不算在告诉我一件现实」：复用 AI Task Router 的判定（只问一次，不接它的会话状态机）
 *
 * 于是本模块只剩三件事：把话变成草稿、把草稿写成现实、保证一次确认只写一次。
 * 全程纯函数（除显式的 commit*），宿主组件只负责摆。
 */

import { buildIngredientDraft, tryParseInventoryRecord, tryParseInventoryRecords } from '@/lib/ai/record';
import type { IngredientRecordDraft } from '@/lib/ai/record';
import { routeAITask } from '@/lib/ai/tasks';
import { RECORD_QUESTION_GUARD_RE } from '@/lib/ai/tasks/task-router';
import { CONSUMABLE_NAMES, extractInitialConsumableDrafts } from '@/lib/ai/tasks/consumable-task';
import type { ConsumableDraft } from '@/lib/ai/tasks';
import { commitIngredients } from '@/lib/reality/ingredients';
import type { InventoryIngredient } from '@/lib/types/ingredient';

// ── 步骤：一次线性的见面，没有分支状态机 ──────────────────────────────

/** 四屏：见面 → 冰箱 → 消耗品 → 以后随时说 */
export type OnboardingStep = 'welcome' | 'fridge' | 'consumables' | 'completion';

const STEP_ORDER: readonly OnboardingStep[] = ['welcome', 'fridge', 'consumables', 'completion'];

/**
 * 前进。确认与跳过走同一条路径 —— 任何一步都不许把人堵在门外：
 * 冰箱跳过进消耗品，消耗品跳过进最后一屏，中途全部跳过也算正常完成。
 */
export function advanceStep(step: OnboardingStep): OnboardingStep {
  const index = STEP_ORDER.indexOf(step);
  return STEP_ORDER[Math.min(index + 1, STEP_ORDER.length - 1)];
}

/** 轻步骤提示：只有真正要用户开口的两步计数，见面和告别不算。 */
export function stepProgress(step: OnboardingStep): string | null {
  if (step === 'fridge') return '1 / 2';
  if (step === 'consumables') return '2 / 2';
  return null;
}

/** 文案住在流程里：宿主只管摆，测试只认这里的键。 */
export const ONBOARDING_HINTS = {
  fridgeEmpty: '想到什么说什么就好，比如：牛肉、鸡蛋、西红柿。',
  /** 建议类提问（牛肉、鸡蛋可以做什么？）不属于这里的写入，它属于聊天里的思考链路。 */
  fridgeNotRecord:
    '这句我不确定是要放进冰箱的东西。直接列食材就好：牛肉、鸡蛋、西红柿，也可以一个一个添加。',
  fridgeUnparsed: '这句我没能拆成食材清单。用顿号列一下名字，或者点「一个一个添加」。',
  consumablesEmpty: '说几个常备的就好，比如：纸巾、垃圾袋、洗衣液。',
  /** 「家里纸巾用完了怎么办」是在问轻舍：那是消耗品的聊天链路，不是这里的写入。 */
  consumablesNotRecord:
    '这句我不确定是家里的消耗品。直接列名字就好：纸巾、垃圾袋、洗衣液，也可以一件一件说。',
  consumablesUnrecognized:
    '这句里我没认出常用消耗品。直接列名字就好：纸巾、垃圾袋、洗衣液、洗洁精。',
} as const;

// ── 第一步：冰箱 ─────────────────────────────────────────────────────

export type FridgeInput =
  | { ok: true; drafts: IngredientRecordDraft[] }
  | { ok: false; hint: string };

/**
 * 一句话 → IngredientRecordDraft[]（一张多行确认卡的数据）。
 * 全程不碰 storage：草稿只活在组件里，确认之前冰箱什么都没变。
 */
export function readFridgeInput(text: string): FridgeInput {
  const message = text.trim();
  if (!message) return { ok: false, hint: ONBOARDING_HINTS.fridgeEmpty };

  // 先问 Router：这句是在告诉轻舍一件现实，还是在问轻舍问题？
  // 判定复用已验收的共享词表与守卫，onboarding 不另起一套意图识别。
  if (routeAITask({ message }).intent.taskType !== 'add_inventory') {
    return { ok: false, hint: ONBOARDING_HINTS.fridgeNotRecord };
  }

  // 批量优先（牛肉、豌豆、鸡蛋），单件兜底（牛肉 / 我买了牛肉）：都是 P0.5-1 的原函数
  const single = tryParseInventoryRecord(message);
  const records = tryParseInventoryRecords(message) ?? (single ? [single] : null);
  if (!records) return { ok: false, hint: ONBOARDING_HINTS.fridgeUnparsed };

  const drafts = records.map(record => buildIngredientDraft(record));
  // 名称是最低要求：拆不出名字的半截草稿不配进确认卡，整句不认
  if (drafts.some(draft => draft.status !== 'confirming' || !draft.data.name)) {
    return { ok: false, hint: ONBOARDING_HINTS.fridgeUnparsed };
  }
  return { ok: true, drafts };
}

export interface FridgeCommitResult {
  items: InventoryIngredient[];
  added: number;
}

/**
 * 冰箱确认卡 → 真实库存。一次调用 = 一次写入（卡上 N 样也只落一笔）。
 * 草稿字段是「话」的形状（location），库存字段是「现实」的形状（storageLocation），
 * 转换只在这一行发生，宿主不需要知道两边长什么样。
 */
export function commitFridgeDrafts(drafts: IngredientRecordDraft[]): FridgeCommitResult {
  return commitIngredients(
    drafts.map(draft => ({ ...draft.data, storageLocation: draft.data.location }))
  );
}

/**
 * 「一个一个添加」：现有 AddIngredientModal 的表单结果进同一个写入者，
 * 名称之外的字段一律沿用各自默认值，onboarding 不加必填校验。
 */
export function commitFridgeRecords(
  records: readonly Omit<InventoryIngredient, 'id' | 'createdAt'>[]
): FridgeCommitResult {
  return commitIngredients(records);
}

// ── 第二步：消耗品 ───────────────────────────────────────────────────

export type ConsumablesInput =
  | { ok: true; drafts: ConsumableDraft[] }
  | { ok: false; hint: string };

/**
 * 把解析片段收敛回词库里的最长命中项（不新建词库，只用 CONSUMABLE_NAMES 那一份）。
 *
 * 「我家里一般会备纸巾和垃圾袋」按并列切开后，尾巴是「我家里一般会备纸巾」——
 * 现有解析器认得出里面有纸巾，但整串不能当物品名进账本。取最长命中是为了
 * 「面巾纸」不被同时命中的「纸巾」拆成两条。
 */
export function alignToConsumableName(fragment: string): string | null {
  let hit: string | null = null;
  for (const name of CONSUMABLE_NAMES) {
    if (!fragment.includes(name)) continue;
    if (!hit || name.length > hit.length) hit = name;
  }
  return hit;
}

/**
 * 一句话 → ConsumableDraft[]，交给现有 ConsumableDraftConfirm 一张卡确认、一次写入。
 *
 * 切句、数量、位置一律由现有解析器决定，这里只做两件 onboarding 才需要的事：
 * 把半截句子对齐回物品名（名字是最低要求，认不出名字的碎片不进卡），
 * 以及同名去重（一句话里说两遍「纸巾」不该记两条）。
 *
 * 冰箱那一步会先问 Router「这句算不算在告诉轻舍一件现实」；这一步不整体交给 Router ——
 * 消耗品的现有入口绑定的是「买了/囤了」这类购买语义，而这里是「我家有什么」的
 * 清单，裸名字在聊天里走对话、在这里恰恰是答案本身。能对齐出物品名就收，
 * 对齐不出就只回一句提示，不猜、不写。
 *
 * 但 Router 的第一道守卫照样要过：录入是陈述行为，「家里纸巾用完了怎么办」「纸巾
 * 用完了吗」是在问轻舍，不是给它一件现实，这类句子在这里同样不落卡。
 * 复用那一条 RECORD_QUESTION_GUARD_RE，不另起一份问句判定。
 */
export function readConsumablesInput(text: string): ConsumablesInput {
  const message = text.trim();
  if (!message) return { ok: false, hint: ONBOARDING_HINTS.consumablesEmpty };
  if (RECORD_QUESTION_GUARD_RE.test(message)) {
    return { ok: false, hint: ONBOARDING_HINTS.consumablesNotRecord };
  }

  const byName = new Map<string, ConsumableDraft>();
  for (const draft of extractInitialConsumableDrafts(message)) {
    const name = alignToConsumableName(draft.name);
    if (name && !byName.has(name)) byName.set(name, { ...draft, name });
  }
  if (byName.size === 0) return { ok: false, hint: ONBOARDING_HINTS.consumablesUnrecognized };
  return { ok: true, drafts: [...byName.values()] };
}

// ── 防重复写入：一次确认只落一次盘 ───────────────────────────────────

/**
 * 门闩（十七 / ONB-13）。
 *
 * 不能只靠 React 的 pending state：同一 tick 里的两次点击读到的是同一个旧值。
 * 门闩活在组件之外，宿主用 useRef 持有它 —— 进入即占用，成功即锁死，抛错才允许重试。
 */
export interface ConfirmLatch {
  isBusy(): boolean;
  isCommitted(): boolean;
  run<T>(write: () => T): CommitOutcome<T>;
}

export type CommitOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'busy' | 'already-committed' };

export function createConfirmLatch(): ConfirmLatch {
  let busy = false;
  let committed = false;
  return {
    isBusy: () => busy,
    isCommitted: () => committed,
    run: <T>(write: () => T): CommitOutcome<T> => {
      if (busy) return { ok: false, reason: 'busy' };
      if (committed) return { ok: false, reason: 'already-committed' };
      busy = true;
      try {
        const value = write();
        committed = true;
        return { ok: true, value };
      } finally {
        busy = false;
      }
    },
  };
}