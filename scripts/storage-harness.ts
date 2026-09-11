/**
 * Storage 闭环回归 Harness（离线，不依赖浏览器）
 *
 * 覆盖「确认卡片 → qingshe_consumables + qingshe_reminders」与
 * 「状态回写 → 消耗品 + 提醒重算」两条真实写入链。
 * 用最小 localStorage 垫片替代浏览器环境：storage 模块只依赖
 * getItem/setItem，因此断言的就是线上真正落盘的那份 JSON。
 */

/* ---------- 浏览器垫片：必须在调用 storage 模块前装好 ---------- */

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
(globalThis as any).window = { localStorage: fakeLocalStorage };
(globalThis as any).localStorage = fakeLocalStorage;

/* ---------- 被测模块 ---------- */

import { loadConsumables, addConsumables } from '../src/lib/reality/consumables';
import {
  loadReminders,
  saveReminders,
  addReminders,
  createReminder
} from '../src/lib/reality/reminders';
import {
  planConsumableReminders,
  silenceConsumableReminders
} from '../src/lib/reality/consumable-reminders';
import { applyConsumableStatusUpdates } from '../src/lib/reality/consumable-updates';
import {
  addItemsToShoppingList,
  commitShoppingDrafts,
  getShoppingLists,
  saveShoppingLists,
  toggleShoppingItem,
  markShoppingItemRestocked,
  createShoppingListFromRecipe,
  addShoppingList,
  resolveItemSource
} from '../src/lib/reality/shopping-lists';
import {
  loadIngredients,
  saveIngredients,
  commitIngredients,
  consumeIngredients,
  groupIngredientsByStorage
} from '../src/lib/reality/ingredients';
import { updateInventory } from '../src/lib/reality/inventory-update';
import {
  shoppingItemToRestockDraft,
  inventoryIngredientFromRestockDraft,
  tryParseInventoryRecords,
  buildIngredientDraft
} from '../src/lib/ai/record';
import { recipeIngredientsToShoppingDrafts } from '../src/lib/ai/tasks';
import type { RecipeIngredient } from '../src/lib/types/recipe';
import type { Recipe } from '../src/lib/types/recipe';
import { analyzeFoodIngredients } from '../src/lib/ai/food-analysis';
import { matchRecipes } from '../src/lib/ai/recipe-match';
import { extractInitialConsumableDrafts } from '../src/lib/ai/tasks/consumable-task';
import {
  applyConsumableSessionReply,
  mergeConsumableDrafts
} from '../src/lib/ai/tasks/consumable-session';
import type { ConsumableItem } from '../src/lib/types/consumable';
import type { ShoppingItemDraft } from '../src/lib/ai/tasks';
import { describeStorageLocation, type InventoryIngredient } from '../src/lib/types/ingredient';
import type { ConsumedIngredient } from '../src/lib/types/execution-result';
import { readFileSync } from 'fs';
import { join } from 'path';
// P0_5_3：采购完成入库这一段直接打真实的 route handler，核心链路一律不 mock。
import { POST } from '../src/app/api/ai/chat/route';
import type { ShoppingList } from '../src/lib/types/shopping-list';
import type { ChatApiResponse } from '../src/lib/types/chat';

// route.ts 在 Router Gate 之前先校验 AMD_AI_API_KEY / AMD_AI_MODEL，
// complete_purchase 这种纯确定性分支也要过这道门。做法与 route-harness 一致：
// 只把 .env.local 灌进 process.env，不 mock 任何逻辑。
// 必须排在所有 import 之后 —— TS 编译成 CJS 时 require 按源码顺序落地，放前面拿到的是 undefined。
if (!process.env.AMD_AI_API_KEY) {
  const envText = readFileSync(join(process.cwd(), '.env.local'), 'utf-8');
  for (const line of envText.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

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

/** P0_5_3：POST 只需要 request.json()；与 route-harness 同一形状，不起 HTTP 服务 */
async function chatJson(body: unknown): Promise<ChatApiResponse> {
  const res = await POST({ json: async () => body } as never);
  return (await res.json()) as ChatApiResponse;
}

function daysFromToday(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.round(ms / 86_400_000);
}

function seedConsumable(overrides: Partial<ConsumableItem>): ConsumableItem {
  const now = new Date().toISOString();
  return {
    id: `seed_${Math.random().toString(36).slice(2, 8)}`,
    name: '面巾纸',
    quantity: 1,
    unit: '箱',
    location: '储物间',
    status: 'unknown',
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

/** 复刻 ConsumableDraftConfirm.handleConfirm 的写入序列 */
function commitAsConfirmCard(items: ConsumableItem[]) {
  addConsumables(loadConsumables(), items);
  addReminders(
    loadReminders(),
    items.flatMap((item) => planConsumableReminders(item).map(createReminder))
  );
}

/* ---------- 用例 ---------- */

async function main() {
  // S1：确认卡片必须同时写消耗品和提醒，且提醒通过 resourceId 关联
  resetStorage();
  const s1 = seedConsumable({ name: '面巾纸', checkIntervalDays: 20 });
  commitAsConfirmCard([s1]);
  const s1Reminders = loadReminders().filter((r) => r.resourceId === s1.id);
  check(
    'S1 确认后 qingshe_consumables 落盘 1 条',
    loadConsumables().length === 1,
    `实际 ${loadConsumables().length}`
  );
  check(
    'S1 确认后 qingshe_reminders 建立 reality_check 并关联 resourceId',
    s1Reminders.length === 1 &&
      s1Reminders[0].type === 'reality_check' &&
      s1Reminders[0].resourceType === 'consumable' &&
      s1Reminders[0].intervalDays === 20 &&
      daysFromToday(s1Reminders[0].nextTriggerAt!) === 20,
    JSON.stringify(s1Reminders)
  );
  check(
    'S1 只写 qingshe_consumables / qingshe_reminders 两个 owner',
    JSON.stringify(Object.keys(fakeLocalStorage._dump()).sort()) ===
      JSON.stringify(['qingshe_consumables', 'qingshe_reminders']),
    JSON.stringify(Object.keys(fakeLocalStorage._dump()))
  );

  // S2：未知余量 → 只建 reality_check，兜底 14 天
  resetStorage();
  const s2 = seedConsumable({ name: '垃圾袋' });
  commitAsConfirmCard([s2]);
  const s2Reminders = loadReminders().filter((r) => r.resourceId === s2.id);
  check(
    'S2 未提供节奏 → 仅 1 条 reality_check，兜底 14 天',
    s2Reminders.length === 1 &&
      s2Reminders[0].type === 'reality_check' &&
      daysFromToday(s2Reminders[0].nextTriggerAt!) === 14,
    JSON.stringify(s2Reminders)
  );

  // S3：已知 20 天用完 → replenishment 提前 5 天 + reality_check
  resetStorage();
  const s3 = seedConsumable({ name: '洗衣液', estimatedRunOutDays: 20 });
  commitAsConfirmCard([s3]);
  const s3Reminders = loadReminders().filter((r) => r.resourceId === s3.id);
  const s3Replenish = s3Reminders.find((r) => r.type === 'replenishment');
  check(
    'S3 预计20天用完 → 补货提醒落在第 15 天',
    !!s3Replenish && daysFromToday(s3Replenish.nextTriggerAt!) === 15,
    JSON.stringify(s3Replenish)
  );

  // S4：已进入补货窗口（3 天）→ 不建未来补货提醒，交给紧急卡片即时提示
  resetStorage();
  const s4 = seedConsumable({ name: '牙膏', estimatedRunOutDays: 3 });
  commitAsConfirmCard([s4]);
  const s4Reminders = loadReminders().filter((r) => r.resourceId === s4.id);
  check(
    'S4 预计3天用完 → 不建补货提醒，仅保留 reality_check',
    s4Reminders.length === 1 && s4Reminders[0].type === 'reality_check',
    JSON.stringify(s4Reminders)
  );

  // S5：状态回写「还有3天用完」→ 消耗品 + 提醒一起更新
  resetStorage();
  const s5 = seedConsumable({ name: '面巾纸', checkIntervalDays: 30 });
  commitAsConfirmCard([s5]);
  const s5Applied = applyConsumableStatusUpdates([
    {
      consumableId: s5.id,
      urgency: 'urgent',
      markFinished: false,
      estimatedRunOutDays: 3
    }
  ]);
  const s5Item = loadConsumables().find((i) => i.id === s5.id)!;
  const s5Reminders = loadReminders().filter(
    (r) => r.resourceId === s5.id && r.status === 'active'
  );
  check(
    'S5 回写后 estimatedRunOutDays=3 / status=running_low',
    s5Applied.length === 1 &&
      s5Item.estimatedRunOutDays === 3 &&
      s5Item.status === 'running_low',
    JSON.stringify(s5Item)
  );
  check(
    'S5 旧 reality_check 被替换，不残留 30 天的过期节奏',
    s5Reminders.length === 1 &&
      s5Reminders[0].intervalDays === 30 &&
      daysFromToday(s5Reminders[0].nextTriggerAt!) === 30,
    JSON.stringify(s5Reminders)
  );

  // S6：状态回写「用完了」→ 提醒全部撤销
  resetStorage();
  const s6 = seedConsumable({ name: '纸巾', estimatedRunOutDays: 10 });
  commitAsConfirmCard([s6]);
  applyConsumableStatusUpdates([
    { consumableId: s6.id, urgency: 'urgent', markFinished: true, remainingQuantity: 0 }
  ]);
  const s6Item = loadConsumables().find((i) => i.id === s6.id)!;
  const s6Active = loadReminders().filter(
    (r) => r.resourceId === s6.id && r.status === 'active'
  );
  check(
    'S6 用完 → status=finished 且 quantity=0',
    s6Item.status === 'finished' && s6Item.quantity === 0,
    JSON.stringify(s6Item)
  );
  check(
    'S6 用完 → 不再残留 active 提醒',
    s6Active.length === 0,
    JSON.stringify(s6Active)
  );

  // S7：纯数量陈述不得把已估算条目降级
  resetStorage();
  const s7 = seedConsumable({ name: '垃圾袋', estimatedRunOutDays: 25, status: 'estimated' });
  commitAsConfirmCard([s7]);
  applyConsumableStatusUpdates([
    { consumableId: s7.id, urgency: 'normal', markFinished: false, remainingQuantity: 4 }
  ]);
  const s7Item = loadConsumables().find((i) => i.id === s7.id)!;
  check(
    'S7 「还剩4卷」→ quantity=4 且保留 estimated',
    s7Item.quantity === 4 && s7Item.status === 'estimated',
    JSON.stringify(s7Item)
  );

  // S8：silence 不影响其它消耗品的提醒
  resetStorage();
  const s8a = seedConsumable({ name: 'A' });
  const s8b = seedConsumable({ name: 'B' });
  commitAsConfirmCard([s8a, s8b]);
  saveReminders(silenceConsumableReminders(s8a.id, loadReminders()));
  const s8bActive = loadReminders().filter(
    (r) => r.resourceId === s8b.id && r.status === 'active'
  );
  check(
    'S8 撤销 A 的提醒不影响 B',
    s8bActive.length === 1,
    JSON.stringify(s8bActive)
  );

  /* ---------- 5. ShoppingDraftConfirm 确认 → 真实写入采购清单 ---------- */

  console.log('\n=== ShoppingDraftConfirm 确认写入 ===');
  resetStorage();
  // 复刻 ShoppingDraftConfirm.handleConfirm：drafts 是唯一数据源，确认后直接落盘。
  // addItemsToShoppingList 内部会在没有清单时自建 manual 清单并 save，
  // 所以这里断言的是真实 localStorage 内容，而不是函数返回值。
  const sDrafts: ShoppingItemDraft[] = [
    { name: '面巾纸', quantity: 1, unit: '包', budget: 20, neededBy: '明天' }
  ];
  const sResult = addItemsToShoppingList(getShoppingLists(), {
    items: sDrafts,
    source: 'ai'
  });
  const sList = JSON.parse(String(localStorage.getItem('qingshe_shopping_lists')));
  const sItem = sList[0]?.items?.find((i: { name: string }) => i.name === '面巾纸');
  console.log(
    `added=${sResult.addedItems.length} 清单数=${sList.length} ` +
      `面巾纸 qty=${sItem?.quantity}${sItem?.unit ?? ''} ` +
      `budget=${sItem?.budget ?? '-'} neededBy=${sItem?.neededBy ?? '-'}`
  );
  check(
    'S9 确认后物品真实写入 qingshe_shopping_lists（含 budget / neededBy）',
    sResult.addedItems.length === 1 &&
      sList.length === 1 &&
      !!sItem &&
      sItem.quantity === 1 &&
      sItem.unit === '包' &&
      sItem.budget === 20 &&
      sItem.neededBy === '明天',
    JSON.stringify(sItem)
  );

  /* ---------- S10（Case B）：批量续采 → 确认落库不重复 ---------- */

  console.log('\n=== 批量消耗品续采确认落库（Case B）===');
  resetStorage();
  const bRound1 = extractInitialConsumableDrafts('今天买了1箱面巾纸和1瓶生抽');
  const bRound2 = extractInitialConsumableDrafts(
    '面巾纸放在储物室，生抽放在厨房，20天提醒一次'
  );
  const bSession = applyConsumableSessionReply(
    mergeConsumableDrafts(bRound1, bRound2),
    '面巾纸放在储物室，生抽放在厨房，20天提醒一次'
  );
  // 复刻 ConsumableDraftConfirm.handleConfirm 的 draft → item 映射
  const bNow = new Date().toISOString();
  const bItems: ConsumableItem[] = bSession.drafts.map((d) => ({
    id: `consumable_${Math.random().toString(36).slice(2, 8)}`,
    name: d.name.trim(),
    ...(d.quantity != null ? { quantity: d.quantity } : {}),
    ...(d.unit ? { unit: d.unit } : {}),
    ...(d.location ? { location: d.location } : {}),
    ...(d.estimatedRunOutDays != null
      ? { estimatedRunOutDays: d.estimatedRunOutDays }
      : {}),
    ...(d.checkIntervalDays != null
      ? { checkIntervalDays: d.checkIntervalDays }
      : {}),
    status: d.estimatedRunOutDays != null ? 'estimated' : 'unknown',
    createdAt: bNow,
    updatedAt: bNow
  }));
  commitAsConfirmCard(bItems);
  const bStored = loadConsumables();
  console.log(
    `续采草稿数=${bSession.drafts.length} 存储条数=${bStored.length} ` +
      bStored
        .map((i) => `${i.name}@${i.location ?? '-'}!${i.checkIntervalDays ?? '-'}d`)
        .join(' ')
  );
  check(
    'S10 两轮续采确认后 qingshe_consumables 仅 2 条（面巾纸@储物室 / 生抽@厨房，无位置污染名）',
    bSession.drafts.length === 2 &&
      bStored.length === 2 &&
      bStored[0].name === '面巾纸' &&
      bStored[0].location === '储物室' &&
      bStored[1].name === '生抽' &&
      bStored[1].location === '厨房',
    JSON.stringify(bStored.map((i) => `${i.name}@${i.location ?? '-'}`))
  );

  /* ---------- R: Recipe 缺料 → Shopping Draft（P0-A 接线） ---------- */

  const rTomato: RecipeIngredient = { name: '番茄', quantity: '2个', unit: '个', required: true };
  const rSalt: RecipeIngredient = { name: '盐', quantity: '适量', unit: '', required: true };
  const rGinger: RecipeIngredient = { name: '姜', quantity: '10g', unit: 'g', required: true };
  const rChili: RecipeIngredient = { name: '小米辣', quantity: '1根', unit: '根', required: false };

  const r1 = recipeIngredientsToShoppingDrafts(
    [rTomato, rSalt, rGinger, rChili],
    ['番茄', '盐', '姜']
  );
  check(
    'R1 缺料草稿字段来自结构化 ingredients：数量取前导数字、unit 原样、非数字留空',
    r1.length === 3 &&
      r1[0].name === '番茄' &&
      r1[0].quantity === 2 &&
      r1[0].unit === '个' &&
      r1[1].name === '盐' &&
      r1[1].quantity === undefined &&
      r1[1].unit === undefined &&
      r1[2].quantity === 10,
    JSON.stringify(r1)
  );

  const r2 = recipeIngredientsToShoppingDrafts(
    [rChili, rGinger],
    ['小米辣', '豆腐', '姜', '姜']
  );
  check(
    'R2 草稿只认名集（required 过滤归上游）；结构化命中在前、降级名在后；重名去重',
    r2.length === 3 &&
      r2[0].name === '小米辣' &&
      r2[0].quantity === 1 &&
      r2[1].name === '姜' &&
      r2[1].quantity === 10 &&
      r2[2].name === '豆腐' &&
      r2[2].quantity === undefined,
    JSON.stringify(r2)
  );

  check(
    'R3 无缺料名集时不产出草稿（没有可确认的卡就没有写入）',
    recipeIngredientsToShoppingDrafts([rTomato], []).length === 0,
    JSON.stringify(recipeIngredientsToShoppingDrafts([rTomato], []))
  );

  resetStorage();
  const r4Before = JSON.stringify(fakeLocalStorage._dump());
  const r4Drafts = recipeIngredientsToShoppingDrafts([rTomato, rSalt], ['番茄', '盐']);
  check(
    'R4a 转换是纯函数：不碰 localStorage',
    JSON.stringify(fakeLocalStorage._dump()) === r4Before,
    JSON.stringify(fakeLocalStorage._dump())
  );
  // R4b：转换产物必须能被现有确认链的落库出口直接消费（类型兼容 = 无第二套结构）
  const r4Added = commitShoppingDrafts(r4Drafts);
  const r4Lists = getShoppingLists();
  check(
    'R4b 草稿直接经 commitShoppingDrafts 落进 qingshe_shopping_lists（番茄 2个 / 盐 无数）',
    r4Added.length === 2 &&
      r4Lists.length === 1 &&
      r4Lists[0].items.length === 2 &&
      r4Lists[0].items.every((i) => i.status === 'pending') &&
      r4Lists[0].items.some((i) => i.name === '番茄' && i.quantity === 2 && i.unit === '个') &&
      r4Lists[0].items.some((i) => i.name === '盐' && i.quantity === undefined),
    JSON.stringify(r4Lists)
  );

  /* ---------- P0-B 采购完成 → 食材确认入库 ---------- */

  resetStorage();
  // AI 来源清单：一个带结构化 quantity/unit，一个什么附属信息都没有
  const bAiRes = addItemsToShoppingList(getShoppingLists(), {
    items: [{ name: '番茄', quantity: 2, unit: '个' }, { name: '豆腐' }],
    source: 'ai'
  });
  // Recipe 来源清单（P0-A 链路）：quantity 是展示串，unit 独立
  const bRecipeList = createShoppingListFromRecipe({
    id: 'list_recipe_b',
    title: '麻婆豆腐',
    recipeId: 'recipe_mapo',
    missingNames: ['小米辣']
  });
  const bLists = addShoppingList(getShoppingLists(), bRecipeList);
  const bAiList = bAiRes.lists.find((l) => l.id === bAiRes.shoppingList.id)!;
  const bTomato = bAiList.items.find((i) => i.name === '番茄')!;
  const bTofu = bAiList.items.find((i) => i.name === '豆腐')!;
  const bChili = bLists.find((l) => l.id === 'list_recipe_b')!.items[0];

  // B1 勾选 purchased（走真实 toggleShoppingItem）→ 生成 confirming draft，但不碰库存
  const bToggled = toggleShoppingItem(bLists, bAiList.id, bTomato.id);
  const bTomatoPurchased = bToggled
    .find((l) => l.id === bAiList.id)!
    .items.find((i) => i.id === bTomato.id)!;
  check(
    'B1a toggle 语义不变：purchased 可逆（toggleShoppingItem 幂等往返）',
    bTomatoPurchased.status === 'purchased' &&
      toggleShoppingItem(bToggled, bAiList.id, bTomato.id)
        .find((l) => l.id === bAiList.id)!
        .items.find((i) => i.id === bTomato.id)!.status === 'pending',
    JSON.stringify(bTomatoPurchased)
  );
  const bIngredientsBefore = JSON.stringify(fakeLocalStorage._dump());
  const bDraft = shoppingItemToRestockDraft(bTomatoPurchased);
  check(
    'B1b purchased → confirming 草稿（name/quantity/unit 齐），qingshe_ingredients 零字节未动',
    !!bDraft &&
      bDraft.status === 'confirming' &&
      bDraft.missingFields.length === 0 &&
      bDraft.data.name === '番茄' &&
      JSON.stringify(fakeLocalStorage._dump()) === bIngredientsBefore,
    JSON.stringify({ draft: bDraft, inv: fakeLocalStorage.getItem('qingshe_ingredients') })
  );
  check(
    'B1c pending item 不出卡：勾选前没有任何入库资格',
    shoppingItemToRestockDraft(bChili) === null,
    JSON.stringify(shoppingItemToRestockDraft(bChili))
  );

  // B2 确认卡片 → saveIngredients 写入库存
  const bIngredient = inventoryIngredientFromRestockDraft(bDraft!);
  saveIngredients([...loadIngredients(), bIngredient]);
  const bListsAfterConfirm = markShoppingItemRestocked(bToggled, bAiList.id, bTomato.id);
  const bRestockStored = loadIngredients();
  check(
    'B2 确认 → 库存恰好 1 条（名称/数量/单位正确），item 落 restockedAt 标记',
    bRestockStored.length === 1 &&
      bRestockStored[0].name === '番茄' &&
      bRestockStored[0].quantity === '2' &&
      bRestockStored[0].unit === '个' &&
      !!bListsAfterConfirm
        .find((l) => l.id === bAiList.id)!
        .items.find((i) => i.id === bTomato.id)!.restockedAt,
    JSON.stringify({ stored: bRestockStored, list: bListsAfterConfirm.map((l) => l.items.map((i) => i.restockedAt)) })
  );

  // B3 取消卡片 = 收卡（页面本地动作），没有任何存储函数被调用
  check(
    'B3 取消入库卡：不写库存也不打标记（无副作用 = 重新勾选还能再出卡）',
    loadIngredients().length === 1 && // 仍只有 B2 那一条
      !bToggled.find((l) => l.id === bAiList.id)!.items.find((i) => i.id === bTofu.id)!.restockedAt &&
      shoppingItemToRestockDraft({ ...bTofu, status: 'purchased' }) !== null,
    JSON.stringify(loadIngredients())
  );

  // B4 quantity/unit 有则带入：数字原样、展示串取前导数字、显式 unit 优先
  const bShow = shoppingItemToRestockDraft({
    ...bChili,
    status: 'purchased',
    quantity: '4个（约200g）'
  })!;
  const bNumUnit = shoppingItemToRestockDraft({
    ...bChili,
    status: 'purchased',
    quantity: 3,
    unit: '包'
  })!;
  check(
    'B4 有则带入：数字 quantity+unit 原样；展示串 "4个（约200g）" → 4 + 个（括号备注不进字段）',
    bNumUnit.data.quantity === 3 &&
      bNumUnit.data.unit === '包' &&
      bShow.data.quantity === 4 &&
      bShow.data.unit === '个',
    JSON.stringify({ bShow, bNumUnit })
  );

  // B5 quantity/unit 缺失 → 不编造：draft 与落库形状都留空
  const bBare = shoppingItemToRestockDraft({ ...bTofu, status: 'purchased' })!;
  const bBareIngredient = inventoryIngredientFromRestockDraft(bBare);
  check(
    'B5 缺则留空：豆腐草稿无 quantity/unit，落库记录也是空串（不是编造的 "1"/份）',
    bBare.data.quantity === undefined &&
      bBare.data.unit === undefined &&
      bBareIngredient.quantity === '' &&
      bBareIngredient.unit === '' &&
      bBareIngredient.expiryDate === '' &&
      bBareIngredient.storageLocation === '',
    JSON.stringify({ bBare, bBareIngredient })
  );

  // B6 幂等：已入库 item 再点 purchased 永不出卡
  const bRestockedTomato = bListsAfterConfirm
    .find((l) => l.id === bAiList.id)!
    .items.find((i) => i.id === bTomato.id)!;
  check(
    'B6 重复勾选已入库 item → null（restockedAt 是幂等锚点，不产生第二张卡）',
    bRestockedTomato.status === 'purchased' &&
      !!bRestockedTomato.restockedAt &&
      shoppingItemToRestockDraft(bRestockedTomato) === null,
    JSON.stringify(bRestockedTomato)
  );

  // B7 recipe 来源与 ai 来源走同一条回程
  const bChiliPurchased = toggleShoppingItem(bListsAfterConfirm, 'list_recipe_b', bChili.id)
    .find((l) => l.id === 'list_recipe_b')!
    .items.find((i) => i.id === bChili.id)!;
  const bAiDraft = shoppingItemToRestockDraft({ ...bTofu, status: 'purchased' })!;
  const bRecipeDraft = shoppingItemToRestockDraft(bChiliPurchased);
  check(
    'B7 同一函数、同一回程：recipe item（小米辣）与 ai item（豆腐）草稿形状一致',
    !!bRecipeDraft &&
      bRecipeDraft.data.name === '小米辣' &&
      bRecipeDraft.status === bAiDraft.status &&
      bRecipeDraft.type === bAiDraft.type &&
      resolveItemSource(bChiliPurchased) === 'recipe',
    JSON.stringify({ bRecipeDraft, bAiDraft })
  );

  /* ---------- R1：制作消耗不越界、不被旧快照覆盖 ---------- */

  const ing = (over: Partial<InventoryIngredient> & { id: string; name: string }): InventoryIngredient => ({
    quantity: '1',
    unit: 'g',
    category: '其他',
    purchaseDate: '2026-03-01',
    expiryDate: '2026-03-31',
    storageLocation: '冷藏',
    createdAt: '2026-03-01',
    ...over
  });
  const consumed = (
    inventoryIngredientId: string,
    name: string,
    actualQuantity: number,
    confirmed = true
  ): ConsumedIngredient => ({
    inventoryIngredientId,
    name,
    actualQuantity,
    confirmed,
    hasInventoryMatch: true
  });
  const findIng = (id: string) => loadIngredients().find((i) => i.id === id);

  // R1-1 源码级防回归：弹窗不许再出现任何存储直写（带引号的 key 字面量 / setItem / saveIngredients 调用）。
  // 解释性注释里提到 qingshe_ingredients 是允许的，所以只匹配带引号的 key。
  const modalSrc = readFileSync(
    join(__dirname, '..', '..', 'src', 'components', 'RecipeDetailModal.tsx'),
    'utf8'
  );
  check(
    'R1-1 RecipeDetailModal 源码无存储直写：无 localStorage/setItem，写入只走 consumeIngredients',
    !/localStorage/.test(modalSrc) &&
      !/setItem\s*\(/.test(modalSrc) &&
      !/['"]qingshe_ingredients['"]/.test(modalSrc) &&
      !/saveIngredients\s*\(/.test(modalSrc) &&
      /consumeIngredients\s*\(/.test(modalSrc),
    [
      modalSrc.match(/localStorage|setItem\s*\(/g) ?? 'no direct storage write',
      modalSrc.match(/['"]qingshe_ingredients['"]/g) ?? 'no quoted key literal',
      modalSrc.match(/saveIngredients\s*\(/g) ?? 'no direct save'
    ].join(' | ')
  );

  // R1-2 主场景：牛肉+豌豆在册 → 弹窗 mount（拿旧快照）→ 期间洋葱入库 → 弹窗完成制作消耗
  // 结论：洋葱必须在，写回基线是现读的最新库存而不是弹窗那份快照。
  resetStorage();
  saveIngredients([
    ing({ id: 'r1_beef', name: '牛肉', quantity: '500' }),
    ing({ id: 'r1_pea', name: '豌豆', quantity: '300' })
  ]);
  // 弹窗打开那一刻的展示快照（此后不再参与任何写入）
  const r1StaleSnapshot = loadIngredients();
  // 弹窗开着期间：聊天确认卡「新增洋葱」入库
  saveIngredients([...loadIngredients(), ing({ id: 'r1_onion', name: '洋葱', quantity: '2', unit: '个' })]);
  // 弹窗「制作完成 → 确认消耗」：只交消耗项，库存自己现读
  const r1After = consumeIngredients([
    consumed('r1_beef', '牛肉', 500),
    consumed('r1_pea', '豌豆', 100)
  ]);
  check(
    'R1-2 弹窗持旧快照期间洋葱入库，制作消耗后洋葱仍在（旧快照未覆盖最新库存）',
    !!findIng('r1_onion') &&
      r1After.some((i) => i.id === 'r1_onion') &&
      r1StaleSnapshot.every((i) => i.id !== 'r1_onion'),
    JSON.stringify({ stored: loadIngredients().map((i) => `${i.name}@${i.quantity}`), snapshotLen: r1StaleSnapshot.length })
  );

  // R1-3 + R1-4 只动该动的：应消耗的按规则更新，其他记录逐字段不动
  check(
    'R1-3 消耗规则不变：牛肉 500-500 → "0" 且 status=finished（保留记录），豌豆 300-100 → "200" 无 status',
    findIng('r1_beef')?.quantity === '0' &&
      findIng('r1_beef')?.status === 'finished' &&
      findIng('r1_pea')?.quantity === '200' &&
      findIng('r1_pea')?.status === undefined,
    JSON.stringify({ beef: findIng('r1_beef'), pea: findIng('r1_pea') })
  );
  check(
    'R1-4 无关食材逐字段保留：洋葱 quantity/unit/expiry/storageLocation 全部原样',
    (() => {
      const onion = findIng('r1_onion');
      return (
        !!onion &&
        onion.quantity === '2' &&
        onion.unit === '个' &&
        onion.expiryDate === '2026-03-31' &&
        onion.storageLocation === '冷藏' &&
        onion.status === undefined
      );
    })(),
    JSON.stringify(findIng('r1_onion'))
  );

  // R1-5 写回基线来自现读库存：同一批消耗项打在含 third 条的最新库存上，
  // 调用方故意拿旧快照也无从影响结果（consumeIngredients 签名根本不收库存参数）。
  const r1Unmatched = consumeIngredients([
    { ...consumed('r1_ghost', '不存在的库存项', 10) },
    consumed('r1_pea', '豌豆', 0),
    consumed('r1_beef', '牛肉', 999, false)
  ]);
  check(
    'R1-5 现读后消耗：无匹配 id / 消耗 0 / 未确认 全部跳过，最新库存原样返回，洋葱依然在册',
    r1Unmatched.length === 3 &&
      !!findIng('r1_onion') &&
      findIng('r1_beef')?.quantity === '0' &&
      findIng('r1_pea')?.quantity === '200',
    JSON.stringify(r1Unmatched.map((i) => `${i.name}@${i.quantity}`))
  );

  // R1-6 反向场景：先消耗、后新增，两边结果都保留；
  // 且 quantity 无法解析为数字的记录跳过扣减、绝不误删。
  resetStorage();
  saveIngredients([
    ing({ id: 'r2_beef', name: '牛肉', quantity: '500' }),
    ing({ id: 'r2_tofu', name: '豆腐', quantity: '适量' })
  ]);
  consumeIngredients([consumed('r2_beef', '牛肉', 200)]);
  saveIngredients([...loadIngredients(), ing({ id: 'r2_spinach', name: '菠菜', quantity: '1', unit: '把' })]);
  check(
    'R1-6 反向场景：先消耗牛肉 500→300，再入库菠菜，两者共存；非数字 quantity（适量）跳过不删',
    findIng('r2_beef')?.quantity === '300' &&
      !!findIng('r2_spinach') &&
      !!findIng('r2_tofu') &&
      findIng('r2_tofu')?.quantity === '适量',
    JSON.stringify(loadIngredients().map((i) => `${i.name}@${i.quantity}`))
  );

  /* ------------------------------------------------------------------
   * R2：一句话批量冰箱录入（P0.5-1）落盘链
   *
   * 「确认前冰箱零变更、确认后恰好一次写入」是这个切片的全部磁盘承诺：
   *   解析 → buildIngredientDraft 出 5 行 confirming 草稿 —— 此时磁盘必须还是空的；
   *   复刻 route.ts ingredientRecord() + page.tsx SAVE_INGREDIENTS 行映射 ——
   *   与单条卡同一字段语义的批量回放，setItem 计数钉死「一次落盘」；
   *   再走一次 P0-B 的单条回程 —— 证明批量没有把 saveIngredients 变成专用管道。
   * ------------------------------------------------------------------ */

  resetStorage();
  const r2Items = tryParseInventoryRecords(
    '我现在冰箱里有牛肉、豌豆、鸡蛋、西红柿、洋葱，帮我加进冰箱'
  );
  const r2Drafts = (r2Items ?? []).map((item) => buildIngredientDraft(item));
  check(
    'R2-1 一句五料 → 5 行 confirming 草稿（purchaseDate 已折算成日期），确认前 qingshe_ingredients 零写入',
    r2Drafts.length === 5 &&
      r2Drafts.every(
        (d) =>
          d.status === 'confirming' &&
          !!d.data.name &&
          /^\d{4}-\d{2}-\d{2}$/.test(d.data.purchaseDate ?? '')
      ) &&
      r2Drafts.map((d) => d.data.name).join(',') === '牛肉,豌豆,鸡蛋,西红柿,洋葱' &&
      fakeLocalStorage.getItem('qingshe_ingredients') === null,
    JSON.stringify(
      r2Drafts.map((d) => `${d.status}:${d.data.name}@${d.data.purchaseDate}`)
    )
  );

  // 复刻 route.ts 的 ingredientRecord()：草稿 → SAVE_INGREDIENTS 行
  const r2Payload = r2Drafts.map((d) => ({
    name: d.data.name,
    quantity: d.data.quantity ? String(d.data.quantity) : '1',
    unit: d.data.unit || '',
    category: d.data.category || '其他',
    purchaseDate: d.data.purchaseDate,
    expiryDate: d.data.expiryDate || '',
    // 与生产端 ingredientRecord 同源：用户没说位置就是空串，卡片不替它填冷藏
    storageLocation: d.data.location ?? ''
  }));
  // 复刻 page.tsx SAVE_INGREDIENTS 分支：每行 payload → InventoryIngredient，一次 saveIngredients
  const origSetItem = fakeLocalStorage.setItem;
  let r2Writes = 0;
  fakeLocalStorage.setItem = (k: string, v: string) => {
    if (k === 'qingshe_ingredients') r2Writes += 1;
    origSetItem(k, v);
  };
  const r2Stamp = Date.now();
  const r2Rows: InventoryIngredient[] = r2Payload.map((row, index) => ({
    id: `ingredient_${r2Stamp}_${index}`,
    name: String(row.name ?? ''),
    quantity: String(row.quantity || '1'),
    unit: String(row.unit || ''),
    category: String(row.category || '其他') as InventoryIngredient['category'],
    purchaseDate: String(row.purchaseDate ?? ''),
    expiryDate: String(row.expiryDate || ''),
    // Reality 层不再兜底默认位置：空值原样落空串，显示文案由 describeStorageLocation 负责
    storageLocation: String(row.storageLocation ?? '').trim() as InventoryIngredient['storageLocation'],
    createdAt: new Date().toISOString().split('T')[0]
  }));
  saveIngredients([...loadIngredients(), ...r2Rows]);
  fakeLocalStorage.setItem = origSetItem;
  const r2Stored = loadIngredients();
  check(
    'R2-2 一次「全部加入」= qingshe_ingredients 恰好一次 setItem，5 行逐一落盘，默认冷藏/数量1',
    r2Writes === 1 &&
      r2Stored.length === 5 &&
      r2Stored.map((i) => i.name).join(',') === '牛肉,豌豆,鸡蛋,西红柿,洋葱' &&
      r2Stored.every(
        // 「冰箱里有…」说出了区域 → 冷藏是用户给的，不是系统猜的
        (i) => i.storageLocation === '冷藏' && i.quantity === '1' && !!i.purchaseDate
      ),
    JSON.stringify({
      r2Writes,
      stored: r2Stored.map((i) => `${i.name}@${i.quantity}@${i.storageLocation}`)
    })
  );

  // 与 P0-B 单条回程共存：批量入库后再买回补录，仍走同一个 saveIngredients 入口
  const r2Restock = inventoryIngredientFromRestockDraft(
    shoppingItemToRestockDraft({ ...bTofu, status: 'purchased' })!
  );
  saveIngredients([...loadIngredients(), r2Restock]);
  const r2AfterRestock = loadIngredients();
  check(
    'R2-3 批量与 P0-B 单条回程共用同一落盘入口：5+1=6 行，批量行一行不丢',
    r2AfterRestock.length === 6 &&
      ['牛肉', '豌豆', '鸡蛋', '西红柿', '洋葱'].every((n) =>
        r2AfterRestock.some((i) => i.name === n)
      ) &&
      r2AfterRestock.filter((i) => i.name === '豆腐').length === 1,
    JSON.stringify(r2AfterRestock.map((i) => i.name))
  );

  /* ---------- P0_5_3 采购完成 → 入厨房（落盘那一半） ----------
   *
   * route-harness 的 PC 组只验「这句话归谁、出不出卡」，验不了卡落地之后现实数据
   * 长什么样。这里跑 page.tsx 真实的两个来回，核心链路一个都不 mock：
   *   ① 说「我把盐和食用油都买回来了」→ 服务端回 drafts + restockAnchors
   *   ② 点「确认加入厨房」→ cardAction 回程 → SAVE_INGREDIENTS 载荷 → 前端 commitIngredients
   * 两个来回之间故意从别的入口往厨房加一行豆腐：确认写的是「现读追加」，
   * 不是「拿第一轮那份快照覆盖回去」—— 冰箱卡最容易踩的就是这个坑。
   * 真人顺序也照搬：先在清单页把盐/食用油勾成 purchased，再开口说买回来了。
   */

  resetStorage();
  const p53Today = new Date().toISOString().split('T')[0];
  const p53Seeded = addItemsToShoppingList(getShoppingLists(), {
    items: [{ name: '盐' }, { name: '食用油' }, { name: '面巾纸' }],
    source: 'ai'
  }).lists;
  const p53ListId = p53Seeded[0].id;
  const p53ItemId = (name: string) =>
    p53Seeded[0].items.find((item) => item.name === name)!.id;
  saveShoppingLists(
    toggleShoppingItem(
      toggleShoppingItem(p53Seeded, p53ListId, p53ItemId('食用油')),
      p53ListId,
      p53ItemId('盐')
    )
  );

  const p53Sentence = '我把盐和食用油都买回来了，现在可以开始做了';
  const p53Round1Body = (snapshot: ShoppingList[]) => ({
    message: p53Sentence,
    ingredients: loadIngredients(),
    consumables: [],
    myRecipes: [],
    shoppingLists: snapshot
  });
  const p53DumpBefore = JSON.stringify(fakeLocalStorage._dump());
  const p53Round1 = await chatJson(p53Round1Body(getShoppingLists()));

  check(
    'P0_5_3-1 出卡只出草稿：确认之前 localStorage 零写入，厨房没有凭空多行',
    p53Round1.task?.taskType === 'complete_purchase' &&
      (p53Round1.drafts?.length ?? 0) === 2 &&
      (p53Round1.restockAnchors?.length ?? 0) === 2 &&
      JSON.stringify(fakeLocalStorage._dump()) === p53DumpBefore &&
      fakeLocalStorage.getItem('qingshe_ingredients') === null,
    JSON.stringify({
      taskType: p53Round1.task?.taskType,
      drafts: p53Round1.drafts?.map((d) => d.data.name),
      anchors: p53Round1.restockAnchors?.length,
      storageChanged:
        JSON.stringify(fakeLocalStorage._dump()) !== p53DumpBefore,
      ingredientsRaw: fakeLocalStorage.getItem('qingshe_ingredients'),
      raw: p53Round1
    })
  );

  // 确认期间别的入口（onboarding / 手动添加）往厨房加了东西 —— 走同一个写入者
  commitIngredients([{ name: '豆腐', quantity: '1', storageLocation: '冷藏' }]);

  const p53Round2 = await chatJson({
    message: '确认加入厨房',
    ingredients: loadIngredients(),
    consumables: [],
    myRecipes: [],
    shoppingLists: getShoppingLists(),
    drafts: p53Round1.drafts,
    cardAction: { kind: 'ingredient', command: 'confirm' }
  });

  // 前端回程：写库存 + 打清单锚点，与 page.tsx 的 SAVE_INGREDIENTS 分支同一套调用
  if (p53Round2.action === 'SAVE_INGREDIENTS' && p53Round2.ingredients?.length) {
    commitIngredients(p53Round2.ingredients);
    (p53Round1.restockAnchors ?? []).reduce(
      (lists, anchor) =>
        markShoppingItemRestocked(lists, anchor.listId, anchor.itemId),
      getShoppingLists()
    );
  }

  const p53Stored = loadIngredients();
  const p53Names = p53Stored.map((i) => i.name).sort().join(',');
  check(
    'P0_5_3-2 确认期间外部新增的「豆腐」不被覆盖：现读追加，盐/食用油/豆腐三行都在',
    p53Round2.action === 'SAVE_INGREDIENTS' &&
      (p53Round2.ingredients?.length ?? 0) === 2 &&
      p53Names === ['豆腐', '盐', '食用油'].sort().join(','),
    JSON.stringify({
      action: p53Round2.action,
      payload: p53Round2.ingredients,
      names: p53Names,
      expected: ['豆腐', '盐', '食用油'].sort().join(',')
    })
  );

  const p53Items = getShoppingLists()[0].items;
  const p53Restocked = p53Items
    .filter((i) => !!i.restockedAt)
    .map((i) => i.name)
    .sort()
    .join(',');
  const p53SaltRow = p53Stored.find((i) => i.name === '盐');
  const p53PaperRow = p53Items.find((i) => i.name === '面巾纸');
  check(
    'P0_5_3-3 只有被点名且对上清单的条目拿到 restockedAt；面巾纸没被点名，原样不动',
    p53Restocked === ['盐', '食用油'].sort().join(',') &&
      p53PaperRow?.restockedAt === undefined &&
      p53PaperRow?.status === 'pending' &&
      p53Stored.length === 3 &&
      p53SaltRow?.purchaseDate === p53Today &&
      p53SaltRow?.storageLocation === '' &&
      p53SaltRow?.quantity === '1',
    JSON.stringify({
      restocked: p53Restocked,
      paper: p53PaperRow && { status: p53PaperRow.status, restockedAt: p53PaperRow.restockedAt },
      salt: p53SaltRow,
      total: p53Stored.length
    })
  );

  const p53AfterConfirm = JSON.stringify(p53Stored);
  const p53Round3 = await chatJson(p53Round1Body(getShoppingLists()));
  check(
    'P0_5_3-4 同一句「买回来了」再说一遍：已入库的条目不再出第二张卡，库存一行不多',
    p53Round3.task?.taskType !== 'complete_purchase' &&
      !p53Round3.restockAnchors &&
      (p53Round3.drafts?.length ?? 0) === 0 &&
      JSON.stringify(loadIngredients()) === p53AfterConfirm,
    JSON.stringify({
      taskType: p53Round3.task?.taskType,
      drafts: p53Round3.drafts,
      anchors: p53Round3.restockAnchors,
      inventory: loadIngredients().map((i) => i.name)
    })
  );

  /* ---------- P1-2c：我的厨房 = 资源语义统一 ---------- */

  console.log('\n=== P1-2c 我的厨房：未指定 / 分组 / 旧数据 ===');

  resetStorage();
  const kcCommitted = commitIngredients([
    { name: '牛肉', storageLocation: '冷藏' },
    { name: '鸡蛋', storageLocation: '冷藏' },
    { name: '水饺', storageLocation: '冷冻' },
    { name: '食盐', storageLocation: '橱柜' },
    { name: '食用油', storageLocation: '常温' },
    { name: '西红柿' }
  ]).items;
  const kcGroups = groupIngredientsByStorage(kcCommitted);
  const kcNamesOf = (label: string) =>
    (kcGroups.find((group) => group.label === label)?.items ?? []).map((item) => item.name);
  const kcRowOf = (name: string) => kcCommitted.find((item) => item.name === name);

  check(
    'KC1 用户说了冷藏 → 落库是「冷藏」，页面进「冷藏」组',
    kcNamesOf('冷藏').join('+') === '牛肉+鸡蛋' &&
      kcRowOf('牛肉')?.storageLocation === '冷藏' &&
      describeStorageLocation(kcRowOf('牛肉')?.storageLocation) === '冷藏',
    kcGroups.map((group) => `${group.label}(${group.items.length})`).join(' ')
  );

  check(
    'KC2 用户说了冷冻 → 落库是「冷冻」，页面进「冷冻」组',
    kcNamesOf('冷冻').join('+') === '水饺' &&
      kcRowOf('水饺')?.storageLocation === '冷冻' &&
      describeStorageLocation(kcRowOf('水饺')?.storageLocation) === '冷冻',
    `冷冻组=${JSON.stringify(kcNamesOf('冷冻'))}`
  );

  check(
    'KC3 用户说了橱柜 → 进「橱柜」组，绝不因为「厨房=冰箱」被并回冷藏',
    kcNamesOf('橱柜').join('+') === '食盐' && !kcNamesOf('冷藏').includes('食盐'),
    `橱柜组=${JSON.stringify(kcNamesOf('橱柜'))}，冷藏组=${JSON.stringify(kcNamesOf('冷藏'))}`
  );

  check(
    'KC4 用户没说位置 → 单独一组显示「未指定」，底层存空串而不是「未指定」字面量',
    kcNamesOf('未指定').join('+') === '西红柿' &&
      kcRowOf('西红柿')?.storageLocation === '' &&
      describeStorageLocation(kcRowOf('西红柿')?.storageLocation) === '未指定',
    `西红柿.storageLocation=${JSON.stringify(kcRowOf('西红柿')?.storageLocation)}`
  );

  check(
    'KC4b 只有有数据的组才出现，顺序固定为 冷藏→冷冻→橱柜→常温→其他→未指定',
    kcGroups.map((group) => group.label).join('>') === '冷藏>冷冻>橱柜>常温>未指定' &&
      kcGroups.every((group) => group.items.length > 0),
    kcGroups.map((group) => `${group.label}(${group.items.length})`).join(' ')
  );

  // 落库端不再兜底默认位置：这条锁的是「我有鸡蛋」这类无区域句子的最终形状
  resetStorage();
  const kcNoGuess = commitIngredients([{ name: '鸡蛋' }, { name: '土豆', storageLocation: '  ' }]).items;
  check(
    'KC4c commitIngredients 不替用户猜位置：空/空白值一律落空串',
    kcNoGuess.length === 2 && kcNoGuess.every((item) => item.storageLocation === ''),
    JSON.stringify(kcNoGuess.map((item) => `${item.name}:${JSON.stringify(item.storageLocation)}`))
  );

  // 历史数据：旧版本落盘时根本没有 storageLocation 字段；也可能有认不出的手写值
  const legacyRows = [
    {
      id: 'legacy_no_field', name: '老干妈', quantity: '1', unit: '瓶', category: '调味品',
      purchaseDate: '2026-01-01', expiryDate: '', createdAt: '2026-01-01'
    },
    {
      id: 'legacy_odd_value', name: '挂面', quantity: '1', unit: '把', category: '主食',
      purchaseDate: '2026-01-01', expiryDate: '', storageLocation: '碗柜', createdAt: '2026-01-01'
    }
  ] as unknown as InventoryIngredient[];
  const legacyGroups = groupIngredientsByStorage(legacyRows);
  const legacyNamesOf = (label: string) =>
    (legacyGroups.find((group) => group.label === label)?.items ?? []).map((item) => item.name);

  check(
    'KC8 旧数据缺 storageLocation：不报错、不丢行、显示未指定，也不被迁成别的位置',
    legacyNamesOf('未指定').join('+') === '老干妈' && legacyRows[0].storageLocation === undefined,
    legacyGroups.map((group) => `${group.label}(${group.items.length})`).join(' ')
  );

  check(
    'KC8b 认不出的历史值：显示上归进「其他」，字段原值一个字节都不改',
    legacyNamesOf('其他').join('+') === '挂面' &&
      legacyRows[1].storageLocation === '碗柜' &&
      describeStorageLocation('碗柜') === '其他',
    `其他组=${JSON.stringify(legacyNamesOf('其他'))}`
  );

  // 「其他」既是被支持的位置也是兜底归组：一个桶只能出现一次，否则页面把同一批食材显示两遍
  const mixedGroups = groupIngredientsByStorage([
    ...legacyRows,
    { ...legacyRows[1], id: 'declared_other', name: '杂项', storageLocation: '其他' }
  ]);
  check(
    'KC8d 显式「其他」与认不出的值共用一个分组，标题不重复、行数不翻倍',
    mixedGroups.map((group) => group.label).join('>') === '其他>未指定' &&
      mixedGroups.reduce((sum, group) => sum + group.items.length, 0) === mixedGroups.length + 1,
    mixedGroups.map((group) => `${group.label}(${group.items.length})`).join(' ')
  );

  resetStorage();
  fakeLocalStorage.setItem('qingshe_ingredients', JSON.stringify(legacyRows));
  saveIngredients(loadIngredients());
  const legacyAfter = loadIngredients();
  check(
    'KC8c 旧数据整批「读→分组→写回」一趟：行数与字段全须全尾，无需 migration',
    legacyAfter.length === 2 &&
      legacyAfter[0].storageLocation === undefined &&
      legacyAfter[1].storageLocation === '碗柜' &&
      groupIngredientsByStorage(legacyAfter).map((group) => group.label).join('>') === '其他>未指定',
    JSON.stringify(legacyAfter.map((item) => `${item.name}:${JSON.stringify(item.storageLocation)}`))
  );

  /* ---------- P1-2c KC5-KC7：可用性由 status / 保质期决定，与 storageLocation 无关 ----------
   *
   * 直接打真实链路的两段纯函数：analyzeFoodIngredients（决定谁能进 availableIngredients）
   * → matchRecipes（只消费 availableIngredients）。全离线、零 LLM、零 localStorage，
   * 保质期相对「今天」现算，任何一天跑结果都一致。
   * ------------------------------------------------------------------ */

  console.log('\n=== P1-2c KC5-KC7：recipe matching 的可用资源范围 ===');

  const kcDay = (offset: number) =>
    new Date(Date.now() + offset * 86400000).toISOString().split('T')[0];

  const kcRecipe: Recipe = {
    id: 'kc-recipe',
    title: '三味乱炖',
    description: 'KC 回归专用菜谱',
    category: '家常菜',
    ingredients: [
      { name: '牛肉', required: true },
      { name: '豌豆', required: true },
      { name: '食盐', required: true }
    ],
    optionalIngredients: [],
    steps: [{ step: 1, content: '炖' }],
    estimatedTime: 30,
    difficulty: 'easy',
    tags: [],
    sourceType: 'official',
    createdAt: new Date(0),
    updatedAt: new Date(0)
  };

  // 五种位置各出一味可用食材；「未指定」用空串，正是落库的真实形状
  const kcKitchen: InventoryIngredient[] = [
    { id: 'kc-1', name: '牛肉', quantity: '200', unit: 'g', category: '肉类', purchaseDate: kcDay(-1), expiryDate: kcDay(5), storageLocation: '冷藏', createdAt: kcDay(-1) },
    { id: 'kc-2', name: '豌豆', quantity: '1', unit: '把', category: '蔬菜', purchaseDate: kcDay(-1), expiryDate: kcDay(5), storageLocation: '冷冻', createdAt: kcDay(-1) },
    { id: 'kc-3', name: '食盐', quantity: '1', unit: '袋', category: '调味品', purchaseDate: kcDay(-1), expiryDate: kcDay(30), storageLocation: '橱柜', createdAt: kcDay(-1) },
    { id: 'kc-4', name: '鸡蛋', quantity: '3', unit: '个', category: '蛋类', purchaseDate: kcDay(-1), expiryDate: kcDay(5), storageLocation: '常温', createdAt: kcDay(-1) },
    { id: 'kc-5', name: '西红柿', quantity: '2', unit: '个', category: '蔬菜', purchaseDate: kcDay(-1), expiryDate: '', storageLocation: '', createdAt: kcDay(-1) }
  ];

  const kc5Analysis = analyzeFoodIngredients(kcKitchen);
  const kc5Match = matchRecipes(kc5Analysis, [kcRecipe], [])[0];
  check(
    'KC5 冷藏/冷冻/橱柜/常温/未指定五种位置的可用食材全部参与分析与匹配',
    kc5Analysis.availableIngredients.length === 5 &&
      new Set(kc5Analysis.availableIngredients.map((item) => item.storageLocation)).size === 5 &&
      !!kc5Match &&
      kc5Match.availableIngredients.join('+') === '牛肉+豌豆+食盐' &&
      kc5Match.missingIngredients.length === 0 &&
      kc5Match.matchScore === 70,
    `available=${kc5Analysis.availableIngredients.map((item) => `${item.name}(${item.storageLocation || '未指定'})`).join(' ')} ` +
      `| match=${kc5Match ? `${kc5Match.availableIngredients.join('+')}→${kc5Match.matchScore}分` : 'null'}`
  );

  // KC6 只用项目里真实存在的两种「不可用」：status==='finished' 与保质期已过（urgency==='expired'）
  const kc6Kitchen: InventoryIngredient[] = [
    ...kcKitchen,
    { ...kcKitchen[0], id: 'kc-6', name: '酸奶', expiryDate: kcDay(5), storageLocation: '冷藏', status: 'finished' as const },
    { ...kcKitchen[0], id: 'kc-7', name: '豆腐', expiryDate: kcDay(-2), storageLocation: '冷藏' }
  ];
  const kc6Recipe: Recipe = {
    ...kcRecipe,
    id: 'kc-recipe-2',
    ingredients: [...kcRecipe.ingredients, { name: '豆腐', required: true }]
  };
  const kc6Analysis = analyzeFoodIngredients(kc6Kitchen);
  const kc6Names = new Set(kc6Analysis.availableIngredients.map((item) => item.name));
  const kc6Match = matchRecipes(kc6Analysis, [kc6Recipe], [])[0];
  check(
    'KC6 已吃完（finished）不进任何分类；已过期进 expired、不进 available、也不进匹配已有食材',
    !kc6Names.has('酸奶') &&
      !kc6Analysis.expiredIngredients.some((item) => item.name === '酸奶') &&
      !kc6Names.has('豆腐') &&
      kc6Analysis.expiredIngredients.some((item) => item.name === '豆腐') &&
      !!kc6Match &&
      !kc6Match.availableIngredients.includes('豆腐') &&
      kc6Match.missingIngredients.includes('豆腐') &&
      kc6Match.availableIngredients.join('+') === '牛肉+豌豆+食盐',
    `available=${[...kc6Names].join('+')} | expired=${kc6Analysis.expiredIngredients.map((item) => item.name).join('+')} ` +
      `| missing=${kc6Match ? kc6Match.missingIngredients.join('+') : 'null'}`
  );

  // KC7 同一批食材，只改 storageLocation（三档轮换，含空串），可用性结论必须一模一样
  const kc7Variants = [
    kcKitchen,
    kcKitchen.map((item, i) => ({ ...item, storageLocation: ['橱柜', '常温', ''][i % 3] })),
    kcKitchen.map((item, i) => ({ ...item, storageLocation: ['冷冻', '冷藏', '其他'][i % 3] }))
  ];
  const kc7Shapes = kc7Variants.map((items) =>
    JSON.stringify(
      analyzeFoodIngredients(items).availableIngredients
        .map((item) => `${item.name}:${item.urgency}`)
        .sort()
    )
  );
  const kc7Matches = kc7Variants.map((items) => {
    const detail = matchRecipes(analyzeFoodIngredients(items), [kcRecipe], [])[0];
    return JSON.stringify(
      detail && {
        title: detail.recipe.title,
        availableIngredients: detail.availableIngredients,
        missingIngredients: detail.missingIngredients,
        matchScore: detail.matchScore
      }
    );
  });
  check(
    'KC7 仅改变 storageLocation：可用名单、紧急度与匹配结果全部不变',
    kc7Shapes[0] === kc7Shapes[1] && kc7Shapes[1] === kc7Shapes[2] &&
      kc7Matches[0] === kc7Matches[1] && kc7Matches[1] === kc7Matches[2],
    `variant1=...${kc7Shapes[0].slice(-60)} | match1=${kc7Matches[0]}`
  );

  /* ---------- 汇总 ---------- */

  const failed = results.filter((r) => !r.ok);
  console.log('\n=== Storage Harness Summary ===');
  console.log(`Total: ${results.length}  Passed: ${results.length - failed.length}  Failed: ${failed.length}`);
  if (failed.length > 0) {
    console.log('Failed cases:');
    for (const f of failed) console.log(`  - ${f.name}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Harness crashed:', e);
  process.exit(1);
});