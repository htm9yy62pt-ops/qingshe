/**
 * 「建立我的生活」Onboarding Harness（离线，不依赖浏览器、不依赖 React）
 *
 * 覆盖 ONB-1 ~ ONB-17，另加两个专项：A 手动添加路径的唯一写入者、B 四步推进与文案。
 *
 * 为什么可以不碰 React：onboarding 的四件事（出场判定、话→草稿、草稿→现实、
 * 一次确认只写一次）全部住在 src/lib/onboarding 里，组件只负责摆。
 * 因此这里断言的就是线上真正执行的那几个函数，落盘断言直接读 fake localStorage
 * 里的原始 JSON，而不是任何模块的返回值。
 *
 * 「刷新」怎么模拟：onboarding 与生活数据的读取都是每次穿透到 localStorage
 * （模块内不留副本），所以一次刷新 = 丢弃内存里的草稿 + 重新调用读取函数。
 * 每条状态断言都同时检查 readOnboardingState() 与 fakeLocalStorage 里的 raw value，
 * 这样即使哪天有人加了模块级缓存，raw 与返回值一对照就会露馅。
 */

/* ---------- 浏览器垫片：与 storage-harness 同款 ---------- */

function createFakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
    _dump: () => Object.fromEntries(map)
  };
}

const fakeLocalStorage = createFakeStorage();
const globalScope = globalThis as unknown as {
  window: { localStorage: typeof fakeLocalStorage };
  localStorage: typeof fakeLocalStorage;
};
globalScope.window = { localStorage: fakeLocalStorage };
globalScope.localStorage = fakeLocalStorage;

/* ---------- 被测模块 ---------- */

import {
  ONBOARDING_STATE_KEY,
  markOnboardingDone,
  markOnboardingSkipped,
  needsOnboarding,
  readOnboardingState
} from '../src/lib/onboarding/state';
import {
  ONBOARDING_HINTS,
  advanceStep,
  commitFridgeDrafts,
  commitFridgeRecords,
  createConfirmLatch,
  readConsumablesInput,
  readFridgeInput,
  stepProgress
} from '../src/lib/onboarding/flow';
import type { OnboardingStep } from '../src/lib/onboarding/flow';
import { buildIngredientDraft, tryParseInventoryRecords } from '../src/lib/ai/record';
import type { IngredientRecordDraft } from '../src/lib/ai/record';
import { routeAITask } from '../src/lib/ai/tasks';
import {
  commitIngredients,
  loadIngredients,
  saveIngredients
} from '../src/lib/reality/ingredients';
import { loadConsumables } from '../src/lib/reality/consumables';
import { loadReminders } from '../src/lib/reality/reminders';
import { commitConsumables } from '../src/lib/reality/consumable-commit';
import type { InventoryIngredient } from '../src/lib/types/ingredient';
import { readFileSync } from 'fs';
import { join } from 'path';

/* ---------- 断言工具 ---------- */

const results: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, condition: boolean, detail: string) {
  results.push({ name, ok: condition, detail });
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
  if (!condition) console.log(`      ${detail}`);
}

function resetStorage() {
  fakeLocalStorage.clear();
}

/** 盘上到底有没有这个 key（区别于「有 key 但值是空数组」） */
function hasRawKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(fakeLocalStorage._dump(), key);
}

function rawValue(key: string): string | null {
  return fakeLocalStorage.getItem(key);
}

/** 盘上那份 JSON 的条目数；-1 = key 不存在或不是数组 */
function rawArrayLength(key: string): number {
  const raw = rawValue(key);
  if (raw === null) return -1;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : -1;
  } catch {
    return -1;
  }
}

/** 一次刷新后的全部真相：内存清空，只信盘上读回来的那份 */
function refresh() {
  return {
    state: readOnboardingState(),
    needs: needsOnboarding(),
    raw: rawValue(ONBOARDING_STATE_KEY),
    ingredients: loadIngredients(),
    consumables: loadConsumables(),
    reminders: loadReminders()
  };
}

/** name 在 IngredientRecordData 里可选（半截草稿合法地存在过），这里按可选处理 */
function names(items: { name?: string }[]): (string | undefined)[] {
  return items.map((item) => item.name);
}

function today(): string {
  return new Date().toISOString().split('T')[0];
}

const INGREDIENTS_KEY = 'qingshe_ingredients';
const CONSUMABLES_KEY = 'qingshe_consumables';
const REMINDERS_KEY = 'qingshe_reminders';

/** 外部入口（聊天确认卡之外的另一条路）先往冰箱里塞一样东西 */
function seedIngredient(overrides: Partial<InventoryIngredient>): void {
  const existing = loadIngredients();
  saveIngredients([
    ...existing,
    {
      id: `seed_${existing.length}`,
      name: '豆腐',
      quantity: '2',
      unit: '盒',
      category: '豆制品',
      purchaseDate: today(),
      expiryDate: '',
      storageLocation: '冷冻',
      createdAt: today(),
      ...overrides
    }
  ]);
}

/** 一次完整的冰箱输入：拿到 5 条待确认草稿（确认前什么都不写） */
function fridgeFive(): IngredientRecordDraft[] | null {
  const input = readFridgeInput('我现在冰箱里有牛肉、豌豆、鸡蛋、西红柿、洋葱');
  return input.ok ? input.drafts : null;
}

const FRIDGE_FIVE = '我现在冰箱里有牛肉、豌豆、鸡蛋、西红柿、洋葱';
const FRIDGE_NATURAL = '我冰箱里现在有牛肉、鸡蛋和西红柿';
const CONSUMABLE_NATURAL = '我家里一般会备纸巾和垃圾袋';

/* ==================================================================
 * ONB-1 ~ ONB-3：出场判定（只看盘上的原始标记）
 * ================================================================== */

resetStorage();
check(
  'ONB-1 首次进入：盘上无标记 → needsOnboarding=true',
  needsOnboarding() === true && !hasRawKey(ONBOARDING_STATE_KEY) && readOnboardingState() === null,
  `raw=${String(rawValue(ONBOARDING_STATE_KEY))} needs=${needsOnboarding()}`
);

resetStorage();
fakeLocalStorage.setItem(ONBOARDING_STATE_KEY, 'done');
check(
  'ONB-2 盘上 raw=done → needsOnboarding=false 且读取穿透到 raw',
  needsOnboarding() === false && readOnboardingState() === 'done' && rawValue(ONBOARDING_STATE_KEY) === 'done',
  `raw=${String(rawValue(ONBOARDING_STATE_KEY))} state=${String(readOnboardingState())} needs=${needsOnboarding()}`
);

resetStorage();
fakeLocalStorage.setItem(ONBOARDING_STATE_KEY, 'skipped');
check(
  'ONB-3a 盘上 raw=skipped → needsOnboarding=false',
  needsOnboarding() === false && readOnboardingState() === 'skipped',
  `raw=${String(rawValue(ONBOARDING_STATE_KEY))} state=${String(readOnboardingState())} needs=${needsOnboarding()}`
);

// 坏标记：不认识的值等于「没跟人打过照面」，宁可再问一次也不要把人卡在门外
fakeLocalStorage.setItem(ONBOARDING_STATE_KEY, 'pending');
check(
  'ONB-3b 坏标记 pending → 视为首次，needsOnboarding=true',
  needsOnboarding() === true && readOnboardingState() === null && rawValue(ONBOARDING_STATE_KEY) === 'pending',
  `raw=${String(rawValue(ONBOARDING_STATE_KEY))} state=${String(readOnboardingState())} needs=${needsOnboarding()}`
);
fakeLocalStorage.setItem(ONBOARDING_STATE_KEY, 'DONE');
check(
  'ONB-3c 坏标记大小写不符 DONE → needsOnboarding=true',
  needsOnboarding() === true && readOnboardingState() === null,
  `raw=${String(rawValue(ONBOARDING_STATE_KEY))} state=${String(readOnboardingState())}`
);

/* ==================================================================
 * ONB-4 ~ ONB-7：冰箱一步（话 → 草稿 → 确认落盘）
 * ================================================================== */

resetStorage();
const fiveInput = readFridgeInput(FRIDGE_FIVE);
if (!fiveInput.ok) {
  check('ONB-4 五样食材 → 一张多行草稿', false, `hint=${fiveInput.hint}`);
} else {
  const drafts = fiveInput.drafts;
  check(
    'ONB-4 五样食材 → 一张多行草稿（5 条 IngredientRecordDraft）',
    drafts.length === 5 &&
      drafts.every((d) => d.type === 'ingredient' && d.status === 'confirming' && !!d.data.name) &&
      JSON.stringify(names(drafts.map((d) => d.data))) ===
        JSON.stringify(['牛肉', '豌豆', '鸡蛋', '西红柿', '洋葱']),
    `got=${JSON.stringify(drafts.map((d) => d.data))}`
  );
  check(
    'ONB-4 确认之前盘上什么都没有（草稿只活在内存）',
    !hasRawKey(INGREDIENTS_KEY) && rawArrayLength(INGREDIENTS_KEY) === -1 && loadIngredients().length === 0,
    `keys=${JSON.stringify(Object.keys(fakeLocalStorage._dump()))}`
  );
}

resetStorage();
const naturalInput = readFridgeInput(FRIDGE_NATURAL);
check(
  'ONB-4b 自然句式「我冰箱里现在有牛肉、鸡蛋和西红柿」→ 3 条草稿',
  naturalInput.ok &&
    naturalInput.drafts.length === 3 &&
    naturalInput.drafts.every((d) => d.status === 'confirming' && !!d.data.name),
  naturalInput.ok
    ? `got=${JSON.stringify(naturalInput.drafts.map((d) => d.data.name))}`
    : `hint=${naturalInput.hint}`
);

resetStorage();
const fiveForCommit = fridgeFive();
if (!fiveForCommit) {
  check('ONB-5 确认 5 条草稿', false, '前置 readFridgeInput 未成功');
} else {
  const committed = commitFridgeDrafts(fiveForCommit);
  const onDisk = loadIngredients();
  check(
    'ONB-5 确认后 qingshe_ingredients 恰好 5 条',
    committed.added === 5 && rawArrayLength('qingshe_ingredients') === 5 && onDisk.length === 5,
    `added=${committed.added} raw=${String(rawArrayLength('qingshe_ingredients'))} loaded=${onDisk.length}`
  );
  check(
    'ONB-5 默认值：quantity=1 / storageLocation=冷藏 / 日期=今天',
    onDisk.every(
      (item) =>
        item.quantity === '1' &&
        item.storageLocation === '冷藏' &&
        item.createdAt === today() &&
        (item.purchaseDate === '' || item.purchaseDate === today())
    ),
    `items=${JSON.stringify(onDisk)}`
  );
  check(
    'ONB-5 id 全部唯一',
    new Set(onDisk.map((item) => item.id)).size === onDisk.length,
    `ids=${JSON.stringify(onDisk.map((item) => item.id))}`
  );
}

/* ------------------------------------------------------------------ */

resetStorage();
const externalWriteDrafts = fridgeFive();
if (!externalWriteDrafts) {
  check('ONB-6 确认覆盖外部写入', false, '前置 readFridgeInput 未成功');
} else {
  // 确认卡在屏幕上停留时，另一条入口（手动 / 聊天）先把豆腐写进了冰箱。
  // commitIngredients 的先读后写必须让豆腐活过这次确认，而不是被旧快照整盘覆盖。
  seedIngredient({});
  const committed = commitFridgeDrafts(externalWriteDrafts);
  const onDisk = loadIngredients();
  check(
    'ONB-6 确认后恰好 6 条：豆腐在、原 5 样也在（非 snapshot 整体覆盖）',
    committed.added === 5 &&
      onDisk.length === 6 &&
      rawArrayLength(INGREDIENTS_KEY) === 6 &&
      onDisk.some((item) => item.name === '豆腐') &&
      ['牛肉', '豌豆', '鸡蛋', '西红柿', '洋葱'].every((n) =>
        onDisk.some((item) => item.name === n)
      ),
    `added=${committed.added} disk=${JSON.stringify(names(onDisk))}`
  );
}

resetStorage();
const sevenDrafts = fridgeFive();
const sevenNext: OnboardingStep = advanceStep('fridge');
check(
  'ONB-7 冰箱只出草稿不确认 → 盘上无 qingshe_ingredients，下一步是 consumables',
  !!sevenDrafts &&
    sevenDrafts.length === 5 &&
    !hasRawKey(INGREDIENTS_KEY) &&
    loadIngredients().length === 0 &&
    sevenNext === 'consumables',
  `drafts=${sevenDrafts ? sevenDrafts.length : 'null'} next=${sevenNext} keys=${JSON.stringify(Object.keys(fakeLocalStorage._dump()))}`
);

/* ==================================================================
 * ONB-8 ~ ONB-10：消耗品一步（话 → 草稿 → 确认落盘 + 提醒）
 * ================================================================== */

resetStorage();
const consumInput = readConsumablesInput(CONSUMABLE_NATURAL);
check(
  'ONB-8 「我家里一般会备纸巾和垃圾袋」→ 2 条可提交草稿（名字对齐词库最长命中）',
  consumInput.ok &&
    consumInput.drafts.length === 2 &&
    consumInput.drafts.every((d) => !!d.name) &&
    JSON.stringify(consumInput.drafts.map((d) => d.name).sort()) ===
      JSON.stringify(['垃圾袋', '纸巾'].sort()),
  consumInput.ok
    ? `drafts=${JSON.stringify(consumInput.drafts)}`
    : `hint=${consumInput.hint}`
);
check(
  'ONB-8 未 commit 前 qingshe_consumables 不落盘（草稿只活在内存）',
  !hasRawKey(CONSUMABLES_KEY) && loadConsumables().length === 0,
  `keys=${JSON.stringify(Object.keys(fakeLocalStorage._dump()))}`
);

// 问句不是「告诉轻舍一件现实」：三道问句都不许拿到可提交草稿
for (const asked of ['家里纸巾用完了怎么办', '纸巾用完了吗', '家里有哪些纸巾比较好用？']) {
  const out = readConsumablesInput(asked);
  check(
    `ONB-8 「${asked}」→ 不产生可提交草稿`,
    !out.ok,
    out.ok ? `drafts=${JSON.stringify(out.drafts)}` : `hint=${out.hint}`
  );
}

resetStorage();
const nineInput = readConsumablesInput(CONSUMABLE_NATURAL);
if (!nineInput.ok) {
  check('ONB-9 commitConsumables 正式落盘', false, `hint=${nineInput.hint}`);
} else {
  // 落盘只走 reality 层的唯一写入者，harness 不复制第二套 localStorage 逻辑
  const result = commitConsumables(nineInput.drafts);
  const diskConsumables = loadConsumables();
  const diskReminders = loadReminders();
  check(
    'ONB-9 qingshe_consumables 恰好 2 条且名字正确',
    result.items.length === 2 &&
      rawArrayLength(CONSUMABLES_KEY) === 2 &&
      JSON.stringify(names(diskConsumables).slice().sort()) ===
        JSON.stringify(['垃圾袋', '纸巾'].sort()),
    `items=${JSON.stringify(result.items)}`
  );
  check(
    'ONB-9 qingshe_reminders 同步建立：每条消耗品各有归属提醒（resourceId 指回物品）',
    result.reminderCount === diskReminders.length &&
      rawArrayLength(REMINDERS_KEY) === diskReminders.length &&
      diskReminders.length === 2 &&
      diskReminders.every(
        (r) =>
          r.resourceType === 'consumable' &&
          diskConsumables.some((c) => c.id === r.resourceId)
      ),
    `reminderCount=${result.reminderCount} reminders=${JSON.stringify(diskReminders)}`
  );
}

resetStorage();
const tenDrafts = readConsumablesInput(CONSUMABLE_NATURAL);
const tenNext: OnboardingStep = advanceStep('consumables');
check(
  'ONB-10 消耗品只出草稿不确认 → 物品与提醒都不落盘，下一步是 completion',
  tenDrafts.ok &&
    tenDrafts.drafts.length === 2 &&
    !hasRawKey(CONSUMABLES_KEY) &&
    !hasRawKey(REMINDERS_KEY) &&
    loadConsumables().length === 0 &&
    loadReminders().length === 0 &&
    tenNext === 'completion',
  `ok=${tenDrafts.ok} next=${tenNext} keys=${JSON.stringify(Object.keys(fakeLocalStorage._dump()))}`
);