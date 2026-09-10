/**
 * AI 意图路由回归 Harness
 *
 * 直接调用 src/app/api/ai/chat/route.ts 的 POST handler（真实代码路径，
 * 不经过 dev server —— 沙箱环境禁止监听端口）。
 *
 * 运行：
 *   npx tsc -p tsconfig.harness.json
 *   node -r ./scripts/harness-alias.cjs .harness/scripts/route-harness.js
 */
import { POST } from '../src/app/api/ai/chat/route';
import {
  nextActiveTask,
  deriveActiveTask,
  hasActiveConsumableSession,
  hasActiveShoppingSession,
  looksLikeAddConsumable,
  looksLikeAddShoppingItem,
  type ActiveTaskSnapshot
} from '../src/lib/ai/tasks';
import {
  routeAITask,
  bareIngredientListNames,
  FRESH_INGREDIENT_NAMES,
  INGREDIENT_ACTION_RESIDUE_RE,
  FRIDGE_ACTION_TAIL_RE,
  isCookingCapabilityQuery,
  RECORD_QUESTION_GUARD_RE
} from '../src/lib/ai/tasks/task-router';
import { tryParseInventoryRecord, tryParseInventoryRecords, type IngredientRecordDraft } from '../src/lib/ai/record';
import { extractShoppingItems } from '../src/lib/ai/tasks/shopping-task';
import type { IngredientCardAction } from '../src/lib/types/chat';
import { isIngredientDraftDiscard } from '../src/lib/ai/confirmation';
import * as aiService from '../src/lib/ai/service';
import * as intentService from '../src/lib/ai/intent';
import * as recordService from '../src/lib/ai/record';
import { readFileSync } from 'fs';
import { join } from 'path';

// LLM 调用探针：Case D/E 用它证明「确定性命中零 LLM、复杂表达仍走 AI」。
// record.ts 编译后按属性读取 chatWithAI，替换 exports 即可拦截。
let aiCalls = 0;
// CC9 用回复桩：endpoint 回归要验的是「意图判定与食谱匹配不依赖 classifier」，
// 最后那句措辞在离线环境里必然抛错，会把整个响应（含 intent / recipeMatches）带崩。
// 只桩这一次回复，链路判定仍然全部走真实代码。
let aiReplyStub: string | null = null;
let aiSystemPrompt = '';
{
  const original = (aiService as any).chatWithAI;
  (aiService as any).chatWithAI = (...args: unknown[]) => {
    aiCalls += 1;
    const request = args[0] as { messages?: Array<{ role: string; content: string }> } | undefined;
    aiSystemPrompt = (request?.messages ?? [])
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    if (aiReplyStub !== null) return Promise.resolve(aiReplyStub);
    return original(...args);
  };
}

// 字段提取探针：证明「取消」这类口令没有偷偷走 extractIngredientRecord 的 LLM 兜底。
// 只计数不拦截，避免改变 E-case 依赖的真实降级行为。
let llmExtractCalls = 0;
{
  const original = (recordService as any).extractIngredientRecord;
  (recordService as any).extractIngredientRecord = (...args: unknown[]) => {
    llmExtractCalls += 1;
    return original(...args);
  };
}

// ---- 环境准备 -----------------------------------------------------------
Object.assign(process.env, { NODE_ENV: 'development' });

const envPath = join(process.cwd(), '.env.local');
try {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
} catch {
  /* 没有 .env.local 时跳过：只测不依赖 LLM 的分支 */
}

// ---- 结果摘要 -----------------------------------------------------------
const summary: { label: string; pass: boolean; detail: string }[] = [];

let routeDecision = '';
const realLog = (...args: unknown[]) => process.stdout.write(args.join(' ') + '\n');
// 接管 console.log：只保留 [AI_ROUTE] 的 decision，其余开发日志丢弃
console.log = (...args: unknown[]) => {
  const m = args.map(String).join(' ').match(/\[AI_ROUTE\].*?decision: ([\w-]+)/);
  if (m) routeDecision = m[1];
};

function makeRequest(body: unknown) {
  return {
    json: async () => body
  } as never;
}

async function chat(label: string, body: unknown, expect: (got: any) => boolean) {
  routeDecision = '';
  // 探针按「一次请求」计数：不在此归零的话，前面用例触发的 LLM 调用会串到后面，
  // 让一条本来零调用的链路看起来调了两次。
  aiCalls = 0;
  llmExtractCalls = 0;
  let json: any = {};
  try {
    const res = await POST(makeRequest(body));
    json = await res.json();
  } catch (err) {
    json = { error: (err as Error).message };
  }
  const drafts = (json.task?.consumableDrafts ?? json.task?.shoppingDrafts ?? []).map(
    (d: any) =>
      `${d.name}×${d.quantity ?? '-'}${d.unit ?? ''}` +
      `${d.location ? '@' + d.location : ''}` +
      `${d.estimatedRunOutDays ? '/' + d.estimatedRunOutDays + 'd' : ''}` +
      `${d.checkIntervalDays ? '!' + d.checkIntervalDays + 'd' : ''}`
  );
  const got = {
    decision: routeDecision,
    taskType: json.task?.taskType ?? null,
    phase: json.task?.consumablePhase ?? null,
    drafts,
    task: json.task ?? null,
    updates: (json.task?.consumableUpdates ?? []).map(
      (u: any) =>
        `${u.name}:${u.summary}/${u.urgency}` +
        `${u.markFinished ? '/finished' : ''}` +
        `${u.remainingQuantity != null ? '/qty' + u.remainingQuantity : ''}` +
        `${u.estimatedRunOutDays != null ? '/run' + u.estimatedRunOutDays + 'd' : ''}`
    ),
    shopping: (json.task?.shoppingDrafts ?? []).map(
      (d: any) =>
        `${d.name}×${d.quantity ?? '-'}${d.unit ?? ''}` +
        `${d.neededBy ? '/' + d.neededBy : ''}` +
        `${d.budget != null ? '/¥' + d.budget : ''}`
    ),
    draftStatus: json.draft?.status ?? null,
    draftName: json.draft?.data?.name ?? null,
    response: String(json.response ?? json.error ?? '').replace(/\n/g, ' ⏎ '),
    // 原始响应体：断言需要读 task 里的完整草稿，
    // 上面的 response 只是给人看的回复文本，两者不能混用。
    aiCalls,
    llmExtractCalls,
    json
  };
  const pass = expect(got);
  summary.push({ label, pass, detail: JSON.stringify(got) });
  realLog(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
  realLog(`      ${JSON.stringify({ decision: got.decision, taskType: got.taskType, phase: got.phase, drafts: got.drafts, shopping: got.shopping, updates: got.updates, draftStatus: got.draftStatus })}`);
  if (!pass) realLog(`      reply: ${got.response.slice(0, 160)}`);
  return json;
}

// ---- 测试夹具 -----------------------------------------------------------
const consumables = [
  { id: 'c1', name: '面巾纸', quantity: 1, unit: '箱', status: 'estimated', estimatedRunOutDays: 20, checkIntervalDays: 7, createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z' },
  { id: 'c2', name: '洗衣液', quantity: 2, unit: '瓶', status: 'estimated', estimatedRunOutDays: 30, checkIntervalDays: 7, createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z' }
];

const ingredientDraft = {
  type: 'ingredient',
  status: 'collecting',
  data: { name: '番茄' },
  missingFields: ['price', 'expiryDate']
};

async function main() {
let sessionDrafts: any[] = [];

realLog('\n=== Qingshe AI Intent Routing 回归 ===\n');

// Test 1：购买消耗品不得被识别为食材
const t1 = await chat('T1 「今天买了1箱面巾纸」→ add_consumable / collecting', {
  message: '今天买了1箱面巾纸', ingredients: [], consumables: []
}, (g) => g.taskType === 'add_consumable' && g.phase === 'collecting' && g.drafts[0] === '面巾纸×1箱');
sessionDrafts = t1.task?.consumableDrafts ?? [];

// Test 2：续采回答位置（无 Action 关键词）
const t2 = await chat('T2 「放在储物间」→ 续采，仍 collecting', {
  message: '放在储物间', ingredients: [], consumables: [],
  activeTask: { taskType: 'add_consumable', consumableDrafts: sessionDrafts, consumablePhase: 'collecting' }
}, (g) => g.taskType === 'add_consumable' && g.phase === 'collecting' && g.drafts[0] === '面巾纸×1箱@储物间');
sessionDrafts = t2.task?.consumableDrafts ?? sessionDrafts;

// Test 3：补齐节奏 → confirming
await chat('T3 「大概20天用完」→ confirming', {
  message: '大概20天用完', ingredients: [], consumables: [],
  activeTask: { taskType: 'add_consumable', consumableDrafts: sessionDrafts, consumablePhase: 'collecting' }
}, (g) => g.taskType === 'add_consumable' && g.phase === 'confirming' && g.drafts[0] === '面巾纸×1箱@储物间/20d');

// Test 4：采购清单
await chat('T4 「帮我买两包纸巾」→ add_shopping_item', {
  message: '帮我买两包纸巾', ingredients: [], consumables: []
}, (g) => g.taskType === 'add_shopping_item' && g.drafts[0] === '纸巾×2包');

// Test 5：旧 Ingredient Draft 不得劫持其它 Task；这里应继续 draft 收集
await chat('T5 「番茄」+ 旧 Ingredient Draft → decision=continue-draft', {
  message: '番茄', ingredients: [], consumables: [], currentDraft: ingredientDraft
}, (g) => g.decision === 'continue-draft');

// Test 6：无 draft 时「番茄」→ add_inventory（决策可离线断言；字段抽取仍需 LLM）
await chat('T6 「番茄」（无 draft）→ decision=add-inventory', {
  message: '番茄', ingredients: [], consumables: []
}, (g) => g.decision === 'add-inventory');

// Test 7：用完 → urgent + markFinished
await chat('T7 「面巾纸用完了」→ update_consumable_status / urgent', {
  message: '面巾纸用完了', ingredients: [], consumables
}, (g) => g.taskType === 'update_consumable_status' && g.updates[0] === '面巾纸:已用完/urgent/finished/qty0');

// Test 8：余量更新
await chat('T8 「洗衣液还剩两瓶」→ 剩余 2 瓶', {
  message: '洗衣液还剩两瓶', ingredients: [], consumables
}, (g) => g.taskType === 'update_consumable_status' && g.updates[0] === '洗衣液:剩余 2瓶/normal/qty2');

// Test 9：消耗品会话进行中，明确的新 Action 必须打断续采
await chat('T9 「明天帮我买包纸巾」打断消耗品会话 → add_shopping_item', {
  message: '明天帮我买包纸巾', ingredients: [], consumables: [],
  activeTask: { taskType: 'add_consumable', consumableDrafts: sessionDrafts, consumablePhase: 'collecting' }
}, (g) => g.taskType === 'add_shopping_item' && g.drafts[0] === '纸巾×1包');

// Test 10：提问不得被当成状态更新
await chat('T10 「面巾纸还剩多少？」→ 不进入 update_consumable_status', {
  message: '面巾纸还剩多少？', ingredients: [], consumables
}, (g) => g.taskType !== 'update_consumable_status');

// Test 11：一句话多个消耗品 + 位置
await chat('T11 「今天买了洗衣液和垃圾袋，都放阳台」→ 2 个草稿', {
  message: '今天买了洗衣液和垃圾袋，都放阳台', ingredients: [], consumables: []
}, (g) => g.taskType === 'add_consumable' && g.drafts.length === 2 && g.drafts.every((d: string) => d.includes('@阳台')));

// Test 12：生鲜语义仍归冰箱，不被消耗品抢走
await chat('T12 「今天买了三斤番茄」→ decision=add-inventory', {
  message: '今天买了三斤番茄', ingredients: [], consumables: []
}, (g) => g.decision === 'add-inventory');

// ---- 续采优先级（中断修复的核心场景）------------------------------------

// 会话夹具：面巾纸已答完存放位置，正在等「多久用完 / 多久提醒一次」
const collectingTask = (overrides: any[] = []) => ({
  taskType: 'add_consumable',
  consumablePhase: 'collecting',
  consumableDrafts: [
    { name: '面巾纸', quantity: 1, unit: '箱', location: '储物间', locationAnswered: true },
    ...overrides
  ]
});

// Test 13：「20天提醒我一次」是回答提问，不能被 add_reminder 关键词抢走
await chat('T13 「20天提醒我一次」绑定消耗品会话 → confirming', {
  message: '20天提醒我一次', ingredients: [], consumables: [], activeTask: collectingTask()
}, (g) =>
  g.decision === 'continue-consumable' &&
  g.taskType === 'add_consumable' &&
  g.phase === 'confirming' &&
  g.drafts[0] === '面巾纸×1箱@储物间!20d');

// Test 14：同一句话在无会话时仍应落到 add_reminder 占位（不被过度绑定）
await chat('T14 无会话时「20天提醒我一次」→ add_reminder', {
  message: '20天提醒我一次', ingredients: [], consumables: []
}, (g) => g.taskType === 'add_reminder');

// Test 15：会话中新增消耗品 → 并入，已答字段不回退
await chat('T15 会话中「今天买了洗衣液」→ 并入 2 条，面巾纸保留储物间', {
  message: '今天买了洗衣液', ingredients: [], consumables: [], activeTask: collectingTask()
}, (g) =>
  g.taskType === 'add_consumable' &&
  g.drafts.length === 2 &&
  g.drafts[0] === '面巾纸×1箱@储物间' &&
  g.drafts[1].startsWith('洗衣液'));

// ---- 余量天数解析 -------------------------------------------------------

// Test 16：「还有3天」是倒计时，不是剩余 3 箱
await chat('T16 「面巾纸还有3天用完」→ estimatedRunOutDays 3 / urgent', {
  message: '面巾纸还有3天用完', ingredients: [], consumables
}, (g) =>
  g.taskType === 'update_consumable_status' &&
  g.updates[0] === '面巾纸:预计 3 天后用完/urgent/run3d');

// Test 17：超出采购提前量 → normal，且不置 finished
await chat('T17 「洗衣液大概20天用完」→ run20d / normal', {
  message: '洗衣液大概20天用完', ingredients: [], consumables
}, (g) => g.updates[0] === '洗衣液:预计 20 天后用完/normal/run20d');

// Test 18：中文数量 + 周 → 折算成天
await chat('T18 「面巾纸还能用一周」→ run7d / soon', {
  message: '面巾纸还能用一周', ingredients: [], consumables
}, (g) => g.updates[0] === '面巾纸:预计 7 天后用完/soon/run7d');

// ---- 采购会话续采 -------------------------------------------------------

const shoppingTask = {
  taskType: 'add_shopping_item',
  shoppingDrafts: [{ name: '纸巾', quantity: 1, unit: '包' }]
};

// Test 19：只补预算，不重复提问
await chat('T19 采购会话「预算20块」→ 合并 budget', {
  message: '预算20块', ingredients: [], consumables: [], activeTask: shoppingTask
}, (g) =>
  g.decision === 'continue-shopping' &&
  g.taskType === 'add_shopping_item' &&
  g.shopping[0] === '纸巾×1包/¥20');

// Test 20：只补时间
await chat('T20 采购会话「明天买」→ neededBy 明天', {
  message: '明天买', ingredients: [], consumables: [], activeTask: shoppingTask
}, (g) => g.shopping[0] === '纸巾×1包/明天');

// Test 21：会话中追加物品
await chat('T21 采购会话「还有牛奶」→ 追加一条', {
  message: '还有牛奶', ingredients: [], consumables: [], activeTask: shoppingTask
}, (g) => g.shopping.length === 2 && g.shopping[1] === '牛奶×-');

// Test 22：采购会话中明确的新采购请求同样并入（不丢物品）
await chat('T22 采购会话「明天帮我买包纸巾」→ 仍产出草稿', {
  message: '明天帮我买包纸巾', ingredients: [], consumables: [], activeTask: shoppingTask
}, (g) => g.taskType === 'add_shopping_item' && g.shopping.length >= 1);

// Test 23-25：纯字段回答不得凭空造出第二条商品
await chat('T23 采购会话「预算20块」→ 商品数仍为 1', {
  message: '预算20块', ingredients: [], consumables: [], activeTask: shoppingTask
}, (g) => g.shopping.length === 1 && g.shopping[0] === '纸巾×1包/¥20');

await chat('T24 采购会话「明天买」→ 商品数仍为 1', {
  message: '明天买', ingredients: [], consumables: [], activeTask: shoppingTask
}, (g) => g.shopping.length === 1 && g.shopping[0] === '纸巾×1包/明天');

await chat('T25 采购会话「明天买，预算20元」→ 商品数仍为 1', {
  message: '明天买，预算20元', ingredients: [], consumables: [], activeTask: shoppingTask
}, (g) => g.shopping.length === 1 && g.shopping[0] === '纸巾×1包/明天/¥20');

// Test 26：反向保护 —— 真商品不能被字段判定误吞
await chat('T26 「买两包纸巾」→ 纸巾 × 2 包', {
  message: '买两包纸巾', ingredients: [], consumables: []
}, (g) => g.taskType === 'add_shopping_item' && g.shopping[0] === '纸巾×2包');

/* ------------------------------------------------------------------ *
 * D. 真实 UI continuation 链
 *
 * T13/T19 的 activeTask 是手写字面量，只能证明「router 认得这个形状」，
 * 证明不了 page.tsx 真会把它发出去。D 组不手写任何快照：每一轮的
 * activeTask 都由 page.tsx 实际调用的 nextActiveTask / deriveActiveTask
 * 从上一轮真实响应推导出来 —— 测的这条链就是浏览器里跑的那条。
 * ------------------------------------------------------------------ */

const uiBody = (
  message: string,
  activeTask: ActiveTaskSnapshot | null,
  currentDraft?: IngredientRecordDraft,
  cardAction?: IngredientCardAction
) => ({
  message,
  ingredients: [],
  consumables: [],
  activeTask: activeTask ?? undefined,
  currentDraft,
  cardAction
});

// D1：Turn 1 建立会话，activeTask 必须由页面侧同一份推导函数产生
const d1 = await chat(
  'D1 「今天买了1箱面巾纸」→ 页面保存 activeTask',
  uiBody('今天买了1箱面巾纸', null),
  (got) =>
    got.taskType === 'add_consumable' &&
    got.phase === 'collecting' &&
    hasActiveConsumableSession(nextActiveTask(got.json.task) ?? undefined)
);
const d1task = nextActiveTask(d1.task);

// D2：Turn 2 携带 D1 推导出的 activeTask，仍不得落入 add_reminder 占位
const d2 = await chat(
  'D2 「放在储物室，20天提醒一次」→ 续采而非新建提醒',
  uiBody('放在储物室，20天提醒一次', d1task),
  (got) => {
    const draft = got.json.task?.consumableDrafts?.[0];
    return (
      got.decision === 'continue-consumable' &&
      got.phase === 'confirming' &&
      draft?.location === '储物室' &&
      draft?.checkIntervalDays === 20
    );
  }
);

// D3：刷新恢复边界 —— collecting 可恢复，已确认的不得重新劫持聊天
const collectingMessage = {
  role: 'assistant' as const,
  taskType: 'add_consumable' as const,
  consumableDrafts: d1.task?.consumableDrafts ?? [],
  consumablePhase: 'collecting' as const
};
const restored = deriveActiveTask([collectingMessage]);
const restoredAfterCommit = deriveActiveTask([
  { ...collectingMessage, taskResolved: 'committed' as const }
]);
const d3Pass =
  restored?.taskType === 'add_consumable' &&
  restored?.consumablePhase === 'collecting' &&
  hasActiveConsumableSession(restored) &&
  restoredAfterCommit === null;
const d3Detail = `restored=${JSON.stringify(restored)} afterCommit=${JSON.stringify(restoredAfterCommit)}`;
summary.push({
  label: 'D3 刷新恢复 collecting / taskResolved=committed 不恢复',
  pass: d3Pass,
  detail: d3Detail
});
realLog(`${d3Pass ? 'PASS' : 'FAIL'}  D3 刷新恢复 collecting / taskResolved=committed 不恢复`);
if (!d3Pass) realLog(`      ${d3Detail}`);

// D4：采购链 —— 第二句必须进 continueShoppingTask，不被 chat / add_reminder / add_inventory 截走
const s1 = await chat(
  'D4-1 「我想买一包面巾纸」→ 页面保存 shopping activeTask',
  uiBody('我想买一包面巾纸', null),
  (got) =>
    got.taskType === 'add_shopping_item' &&
    hasActiveShoppingSession(nextActiveTask(got.json.task) ?? undefined)
);
const s1task = nextActiveTask(s1.task);

const s2 = await chat(
  'D4-2 「预算20元，明天买」→ 采购续采',
  uiBody('预算20元，明天买', s1task),
  (got) => {
    const drafts = got.json.task?.shoppingDrafts ?? [];
    const draft = drafts[0];
    return (
      got.decision === 'continue-shopping' &&
      // 续采只补字段，条目数必须纹丝不动；多出一条就是幽灵商品
      drafts.length === 1 &&
      draft?.name === '面巾纸' &&
      draft?.quantity === 1 &&
      draft?.unit === '包' &&
      draft?.budget === 20 &&
      draft?.neededBy === '明天' &&
      !drafts.some((d: any) => d.name.includes('预算'))
    );
  }
);

/*
 * Q 组：口语包装的字段回答不得变成新商品。
 *
 * 「告诉我明天买，预算20」里没有任何物品，但「告诉我」「那就」这类言语包装
 * 不在前缀剥离词表里，整句会被当成一条商品名，凭空多出一张幽灵卡片。
 * 判据不是继续枚举包装语，而是反过来问「这名字里还留着时间/金额/人称/言语
 * 动词吗」——留着就不是商品（isCredibleItemName）。
 *
 * Q5 是这组测试的反向保险：闸门只能杀掉句子，不能杀掉商品。
 */
const q1 = await chat(
  'Q-shopping-1 「我想买一包面巾纸」→ 建立采购会话',
  uiBody('我想买一包面巾纸', null),
  (g) =>
    g.taskType === 'add_shopping_item' &&
    g.shopping.length === 1 &&
    hasActiveShoppingSession(nextActiveTask(g.task) ?? undefined)
);
const q1task = nextActiveTask(q1.task);

const q2 = await chat(
  'Q-shopping-2 「告诉我明天买，预算20」→ 只补字段，仍是 1 条',
  uiBody('告诉我明天买，预算20', q1task),
  (g) => {
    const drafts: any[] = g.json.task?.shoppingDrafts ?? [];
    return (
      g.decision === 'continue-shopping' &&
      g.aiCalls === 0 &&
      drafts.length === 1 &&
      drafts[0]?.name === '面巾纸' &&
      drafts[0]?.neededBy === '明天' &&
      drafts[0]?.budget === 20 &&
      !drafts.some((d) => /告诉|明天|预算/.test(d.name))
    );
  }
);
const q2task = nextActiveTask(q2.task);

await chat(
  'Q-shopping-3 「那就明天买」→ 连接词包装不新增条目',
  uiBody('那就明天买', q2task),
  (g) =>
    g.decision === 'continue-shopping' &&
    g.shopping.length === 1 &&
    g.shopping[0] === '面巾纸×1包/明天/¥20'
);

await chat(
  'Q-shopping-4 「20元以内」→ 裸金额不变成叫「元以内」的商品',
  uiBody('20元以内', q2task),
  (g) =>
    g.decision === 'continue-shopping' &&
    g.shopping.length === 1 &&
    g.json.task?.shoppingDrafts?.[0]?.name === '面巾纸' &&
    !g.shopping.some((s: string) => /以内|元/.test(s.split('×')[0]))
);

await chat(
  'Q-shopping-5 「顺便买鸡蛋」→ 真商品照常并入（闸门不误杀）',
  uiBody('顺便买鸡蛋', q2task),
  (g) =>
    g.decision === 'continue-shopping' &&
    g.shopping.length === 2 &&
    g.shopping.some((s: string) => s.startsWith('鸡蛋'))
);

/* ------------------------------------------------------------------ *
 * N 组：否定 / 取消口令的真实行为
 *
 * 审计发现的三个缺口：
 * ① 带对象词的取消（「取消采购清单」）不是纯句，cardCommand 通道接不住，
 *    落进续采被当成补字段，卡片原地不动；
 * ② 条目级移除（「面巾纸不要了」）剥掉否定词后会变成一条正向草稿 ——
 *    用户刚说不要，清单里反而多出来；
 * ③ cardCommand 响应回显草稿，取消之后新消息又渲染一张一模一样的活卡
 *    （幽灵卡片），再点一次确认就写了真实数据。
 * 底线只有一条：否定口令不写真实数据，不留卡片；目标歧义时反问而不是猜。
 * ------------------------------------------------------------------ */
const nOne = [
  { id: 'n1', name: '面巾纸', quantity: 1, unit: '包', neededBy: '明天',
    createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z' }
];
const nTwo = [
  { id: 'n1', name: '面巾纸', quantity: 1, unit: '包', neededBy: '明天',
    createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z' },
  { id: 'n2', name: '垃圾袋', quantity: 1, unit: '卷',
    createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z' }
];
const n1task = { taskType: 'add_shopping_item', shoppingDrafts: nOne };
const n2task = { taskType: 'add_shopping_item', shoppingDrafts: nTwo };

// N1：带对象词的取消口令 → 等价于点击取消按钮；草稿不回显（无幽灵卡片）
await chat('N1 「取消采购清单」→ cardCommand=cancel + 空草稿', uiBody('取消采购清单', n2task), (g) =>
  g.task?.cardCommand === 'cancel' &&
  g.shopping.length === 0 &&
  g.aiCalls === 0);

// N2：条目级移除，单条草稿被移除干净 → 整卡取消
await chat('N2 「面巾纸不要了」→ 全移除 = cancel', uiBody('面巾纸不要了', n1task), (g) =>
  g.task?.cardCommand === 'cancel' &&
  g.shopping.length === 0 &&
  g.aiCalls === 0);

// N3：部分移除 → 新卡只留剩下的，会话继续，不发 cancel 口令
await chat('N3 「不要垃圾袋了」→ 只留面巾纸，会话继续', uiBody('不要垃圾袋了', n2task), (g) =>
  g.task?.cardCommand === undefined &&
  g.shopping.length === 1 &&
  g.shopping[0] === '面巾纸×1包/明天' &&
  g.aiCalls === 0);

// N4：否定采购不建草稿 —— 「不想买纸巾」绝不能变成一条纸巾
await chat('N4 无会话「不想买纸巾」→ 不建草稿', uiBody('不想买纸巾', null), (g) =>
  g.shopping.length === 0);

// N5：食材草稿 + 采购会话同时在，取消指令没点名 → 反问，两张卡都不动
await chat(
  'N5 「取消全部」双目标 → 反问不猜',
  uiBody('取消全部', n2task, {
    type: 'ingredient', status: 'collecting',
    data: { name: '番茄' }, missingFields: ['price', 'expiryDate']
  }),
  (g) =>
    g.response.includes('哪一个') &&
    g.json.draft?.data?.name === '番茄' &&
    g.json.activeTask?.shoppingDrafts?.length === 2 &&
    g.aiCalls === 0
);

// N6：扩展否定词表 —— 「不记了」是纯句口令，走 cardCommand 通道整卡取消
await chat('N6 消耗品会话「不记了」→ cardCommand=cancel', uiBody('不记了', {
  taskType: 'add_consumable', consumablePhase: 'confirming',
  consumableDrafts: [
    { name: '洗衣液', quantity: 1, unit: '瓶', status: 'ready' }
  ]
}), (g) =>
  g.task?.cardCommand === 'cancel' &&
  g.drafts.length === 0 &&
  g.aiCalls === 0);

// N7：「别买X了」是移除句式的一种，与 N2 同一落点
await chat('N7 「别买面巾纸了」→ 全移除 = cancel', uiBody('别买面巾纸了', n1task), (g) =>
  g.task?.cardCommand === 'cancel' &&
  g.shopping.length === 0 &&
  g.aiCalls === 0);

// N8：没有待取消的卡片 → 礼貌空操作，不报错、不建卡
await chat('N8 无会话「取消采购清单」→ 空操作', uiBody('取消采购清单', null), (g) =>
  g.task?.cardCommand === undefined &&
  g.shopping.length === 0 &&
  g.response.includes('没有待确认'));

// N9：幽灵卡片回归 —— 纯句「算了」取消后，响应不得再带出任何草稿
await chat('N9 「算了」取消后不回显草稿', uiBody('算了', n2task), (g) =>
  g.task?.cardCommand === 'cancel' &&
  g.shopping.length === 0 &&
  g.aiCalls === 0);

// N10：移除目标不在草稿里 → 回「清单里没有」，既不移除也不新建
await chat('N10 「纸巾不要了」清单里没有 → 卡片原样', uiBody('纸巾不要了', n2task), (g) =>
  g.task?.cardCommand === undefined &&
  g.shopping.length === 2 &&
  g.response.includes('还没有纸巾') &&
  g.aiCalls === 0);

/* ------------------------------------------------------------------ *
 * N11-N19：否定句绝不能污染正向 parser
 *
 * N1-N10 全部是「一个分句、无话语标记」的口令，所以 105/105 通过的同时
 * 漏掉了两个真实 bug：
 * - 「算了，不买牙膏了」—— 话语标记让整句锚定的守卫正则空手，残句掉进
 *   extractShoppingItems，分裂出「算」「不买牙膏」两条幽灵商品；
 * - 「面巾纸不用买了」——「买了」是「不用买 + 语气词了」的子串巧合，
 *   消耗品分支排在守卫之前，直接把这句话抢走并追问放在哪里/多久用完。
 * 这一组把两种形状钉死。
 * ------------------------------------------------------------------ */

const nOf = (...names: string[]) => ({
  taskType: 'add_shopping_item',
  shoppingDrafts: names.map((name) => ({
    name, quantity: 1, unit: '包',
    createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z'
  }))
});

// N11：话语标记 + 否定采购 → 移除牙膏，零幽灵商品
await chat('N11 「算了，不买牙膏了」→ 移除牙膏，无幽灵商品', uiBody('算了，不买牙膏了', nOf('牙膏')), (g) =>
  g.shopping.length === 0 &&
  !g.shopping.some((s: string) => s.includes('算')) &&
  !g.shopping.some((s: string) => s.includes('不买')) &&
  g.task?.cardCommand === 'cancel' &&
  g.aiCalls === 0);

// N12：裸放弃（没有点名条目）→ 整卡取消，不得把「那算了」当成商品去反问
await chat('N12 「那算了，不买了」→ 整卡取消，unknown 不含那算了', uiBody('那算了，不买了', n2task), (g) =>
  g.task?.cardCommand === 'cancel' &&
  g.shopping.length === 0 &&
  !g.response.includes('那算了') &&
  g.aiCalls === 0);

// N13-N16：否定采购 + 消耗品名 → 一律走采购移除，绝不得进 add_consumable
const notConsumable = (g: any) => g.taskType !== 'add_consumable';

await chat('N13 「面巾纸不用买了」→ 采购移除，非 add_consumable', uiBody('面巾纸不用买了', nOf('面巾纸')), (g) =>
  notConsumable(g) &&
  g.taskType === 'add_shopping_item' &&
  g.task?.cardCommand === 'cancel' &&
  g.shopping.length === 0 &&
  g.aiCalls === 0);

await chat('N14 「牙膏不用买了」→ 采购移除，非 add_consumable', uiBody('牙膏不用买了', nOf('牙膏')), (g) =>
  notConsumable(g) &&
  g.task?.cardCommand === 'cancel' &&
  g.shopping.length === 0 &&
  g.aiCalls === 0);

await chat('N15 「纸巾别买了」→ 只摘纸巾，会话继续', uiBody('纸巾别买了', nOf('纸巾', '面巾纸')), (g) =>
  notConsumable(g) &&
  g.task?.cardCommand === undefined &&
  g.shopping.length === 1 &&
  g.shopping[0].startsWith('面巾纸') &&
  g.aiCalls === 0);

await chat('N16 「洗衣液不要买了」→ 采购移除，非 add_consumable', uiBody('洗衣液不要买了', nOf('洗衣液')), (g) =>
  notConsumable(g) &&
  g.task?.cardCommand === 'cancel' &&
  g.shopping.length === 0 &&
  g.aiCalls === 0);

// N17：反向保护 —— 真·已购语义不能被否定守卫误伤
await chat('N17 「今天买了两包面巾纸」→ 仍走 add_consumable', uiBody('今天买了两包面巾纸', null), (g) =>
  g.taskType === 'add_consumable' &&
  g.drafts.length === 1 &&
  g.drafts[0].startsWith('面巾纸'));

// N18：无采购会话的取消 → 不建商品、不建卡、不发 cardCommand，只回一句说明
await chat('N18 无会话「算了，不买了」→ 空操作', uiBody('算了，不买了', null), (g) =>
  g.task?.cardCommand === undefined &&
  g.shopping.length === 0 &&
  g.drafts.length === 0 &&
  g.response.includes('没有待确认') &&
  g.aiCalls === 0);

// N19：目标不存在 → 保留原条目，不新增、不误删
await chat('N19 「别买纸巾了」清单里没有 → 牙膏保留', uiBody('别买纸巾了', nOf('牙膏')), (g) =>
  g.task?.cardCommand === undefined &&
  g.shopping.length === 1 &&
  g.shopping[0].startsWith('牙膏') &&
  !g.shopping.some((s: string) => s.includes('纸巾')) &&
  g.response.includes('还没有纸巾') &&
  g.aiCalls === 0);

/* ------------------------------------------------------------------ *
 * W 组：口语包装 vs 真实商品
 *
 * 「告诉我 / 提醒我 / 通知我」既不是商品也不是字段，它只是用户在对自己说话。
 * 上一轮把这类整句挡在 credibility 闸门外面，代价是包装语后面的真商品被一起
 * 杀掉。这一组夹住那条缝：包装语必须剥干净，商品必须留得下。
 *
 * 表驱动直接打 extractShoppingItems —— 它是纯函数。走整条链路只会把
 * 「解析对不对」稀释成「路由通不通」，商品名丢了也看不出来。
 * ------------------------------------------------------------------ */
function shoppingParserCheck(
  label: string,
  message: string,
  expected: { name: string; quantity?: number; unit?: string; neededBy?: string }[]
) {
  const got = extractShoppingItems(message).map((d) => ({
    name: d.name,
    quantity: d.quantity,
    unit: d.unit,
    neededBy: d.neededBy
  }));
  const pass =
    got.length === expected.length &&
    expected.every(
      (e, i) =>
        got[i]?.name === e.name &&
        got[i]?.quantity === e.quantity &&
        got[i]?.unit === e.unit &&
        got[i]?.neededBy === e.neededBy
    );
  summary.push({ label, pass, detail: JSON.stringify(got) });
  realLog(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
  if (!pass) realLog(`      期望 ${JSON.stringify(expected)} 实际 ${JSON.stringify(got)}`);
}

// 1~3：包装语 + 真实商品 → 剥掉包装，留下商品和时间
shoppingParserCheck('W1 「告诉我明天买纸巾」→ 纸巾 / 明天', '告诉我明天买纸巾', [
  { name: '纸巾', neededBy: '明天' }
]);
shoppingParserCheck('W2 「提醒我后天买洗衣液」→ 洗衣液 / 后天', '提醒我后天买洗衣液', [
  { name: '洗衣液', neededBy: '后天' }
]);
shoppingParserCheck('W3 「通知我周末买鸡蛋」→ 鸡蛋 / 周末', '通知我周末买鸡蛋', [
  { name: '鸡蛋', neededBy: '周末' }
]);
// 4~6：纯字段补充，一个商品都不许有
shoppingParserCheck('W4 「告诉我明天买，预算20」→ 无商品', '告诉我明天买，预算20', []);
shoppingParserCheck('W5 「那就明天买」→ 无商品', '那就明天买', []);
shoppingParserCheck('W6 「20元以内」→ 无商品', '20元以内', []);
// 7~8：真实新增不许被闸门误杀
shoppingParserCheck('W7 「再加牙膏」→ 牙膏', '再加牙膏', [{ name: '牙膏' }]);
shoppingParserCheck('W8 「还要买洗衣液」→ 洗衣液', '还要买洗衣液', [{ name: '洗衣液' }]);
// 剥包装语不许顺手把数量单位也剥掉
shoppingParserCheck('W9 「提醒我买两包面巾纸」→ 面巾纸 ×2 包', '提醒我买两包面巾纸', [
  { name: '面巾纸', quantity: 2, unit: '包' }
]);
// 包装动词的补语「一下」不能变成商品名的开头
shoppingParserCheck('W13 「提醒我一下买纸巾」→ 纸巾（不残留「下买纸巾」）', '提醒我一下买纸巾', [
  { name: '纸巾' }
]);

/*
 * W10~W12 走完整链路：剥掉包装语之后，剩下的东西该走哪条路。
 * 没有商品 → 只能补字段，条目数纹丝不动；
 * 有商品 → 并入一条，且原草稿已有字段不能被这次并入冲掉。
 */
const w1 = await chat(
  'W10 「我想买一包面巾纸」→ 建立采购会话',
  uiBody('我想买一包面巾纸', null),
  (g) =>
    g.taskType === 'add_shopping_item' &&
    g.shopping.length === 1 &&
    hasActiveShoppingSession(nextActiveTask(g.task) ?? undefined)
);
const w1task = nextActiveTask(w1.task);

await chat(
  'W11 会话中「告诉我明天买，预算20」→ 仍 1 条，只补字段',
  uiBody('告诉我明天买，预算20', w1task),
  (g) => {
    const drafts: any[] = g.json.task?.shoppingDrafts ?? [];
    return (
      g.decision === 'continue-shopping' &&
      g.aiCalls === 0 &&
      drafts.length === 1 &&
      drafts[0]?.name === '面巾纸' &&
      drafts[0]?.quantity === 1 &&
      drafts[0]?.neededBy === '明天' &&
      drafts[0]?.budget === 20
    );
  }
);

await chat(
  'W12 会话中「告诉我明天买纸巾」→ 并入纸巾，面巾纸不丢',
  uiBody('告诉我明天买纸巾', w1task),
  (g) => {
    const drafts: any[] = g.json.task?.shoppingDrafts ?? [];
    return (
      g.decision === 'continue-shopping' &&
      g.aiCalls === 0 &&
      drafts.length === 2 &&
      drafts[0]?.name === '面巾纸' &&
      drafts[0]?.quantity === 1 &&
      drafts[1]?.name === '纸巾' &&
      drafts[1]?.neededBy === '明天'
    );
  }
);

// ---- Case A：批量消耗品续采不重复 ----------------------------------------
const a1 = await chat(
  'A1 「今天买了1箱面巾纸和1瓶生抽」→ 面巾纸/生抽 两条草稿',
  uiBody('今天买了1箱面巾纸和1瓶生抽', null),
  (g) =>
    g.taskType === 'add_consumable' &&
    g.drafts.length === 2 &&
    g.drafts[0].startsWith('面巾纸×1箱') &&
    g.drafts[1].startsWith('生抽×1瓶')
);
await chat(
  'A2 续采「面巾纸放在储物室，生抽放在厨房，20天提醒一次」→ 仍 2 条，位置入字段不入名称',
  uiBody('面巾纸放在储物室，生抽放在厨房，20天提醒一次', nextActiveTask(a1.task)),
  (g) => {
    const ds: any[] = g.json.task?.consumableDrafts ?? [];
    return (
      g.decision === 'continue-consumable' &&
      ds.length === 2 &&
      ds[0]?.name === '面巾纸' &&
      ds[0]?.location === '储物室' &&
      ds[1]?.name === '生抽' &&
      ds[1]?.location === '厨房' &&
      !ds.some((d) => d.name.includes('放在'))
    );
  }
);

// ---- Case C：shopping session 不吞新的现实录入 ----------------------------
const c1 = await chat(
  'C1 「我想买一包牙膏」→ active shopping task',
  uiBody('我想买一包牙膏', null),
  (g) => {
    const snap = nextActiveTask(g.task);
    const active = hasActiveShoppingSession(snap ?? undefined);
    return g.taskType === 'add_shopping_item' && active;
  }
);
await chat(
  'C2 采购会话中「今天买了两个番茄」→ 打断续采，重新路由 add_inventory',
  uiBody('今天买了两个番茄', nextActiveTask(c1.task)),
  (g) =>
    g.decision === 'add-inventory' &&
    g.taskType !== 'add_shopping_item' &&
    g.shopping.length === 0 &&
    g.json.draft?.data?.name === '番茄' &&
    g.json.draft?.data?.quantity === 2
);

// ---- Case D/E：明确录入零 LLM，复杂表达仍 fallback AI ---------------------
aiCalls = 0;
await chat(
  'D-case 「今天买了2个番茄」→ 确定性解析，chatWithAI 调用数为 0',
  uiBody('今天买了2个番茄', null),
  (g) =>
    g.decision === 'add-inventory' &&
    g.aiCalls === 0 &&
    g.json.draft?.data?.name === '番茄' &&
    g.json.draft?.data?.quantity === 2 &&
    g.json.draft?.data?.unit === '个'
);
aiCalls = 0;
await chat(
  'E-case 「刚才顺手买了一些晚上做饭可能用的东西」→ 确定性失败，仍走 extractIngredientRecord',
  uiBody('刚才顺手买了一些晚上做饭可能用的东西', null),
  (g) => g.decision === 'add-inventory' && aiCalls > 0
);

// ---- P 组：tryParseInventoryRecord 纯函数断言 ------------------------------
function parserCheck(
  label: string,
  message: string,
  expect: { name: string; quantity?: number; unit?: string } | null
) {
  const got = tryParseInventoryRecord(message);
  const pass =
    expect === null
      ? got === null
      : !!got &&
        got.name === expect.name &&
        got.quantity === expect.quantity &&
        got.unit === expect.unit;
  summary.push({ label, pass, detail: JSON.stringify(got) });
  realLog(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
  if (!pass) realLog(`      ${JSON.stringify(got)}`);
}

parserCheck('P1 「今天买了2个番茄」→ 番茄×2个', '今天买了2个番茄', { name: '番茄', quantity: 2, unit: '个' });
parserCheck('P2 「买了3个鸡蛋」→ 鸡蛋×3个', '买了3个鸡蛋', { name: '鸡蛋', quantity: 3, unit: '个' });
parserCheck('P3 「刚买了一盒牛奶」→ 牛奶×1盒', '刚买了一盒牛奶', { name: '牛奶', quantity: 1, unit: '盒' });
parserCheck('P4 「今天买了两个番茄」→ 番茄×2个', '今天买了两个番茄', { name: '番茄', quantity: 2, unit: '个' });
parserCheck('P5 「新增2瓶牛奶」→ 牛奶×2瓶', '新增2瓶牛奶', { name: '牛奶', quantity: 2, unit: '瓶' });
parserCheck('P6 模糊长句 → null（留给 AI）', '刚才顺手买了一些晚上做饭可能用的东西', null);
parserCheck('P7 未来意图「帮我买两包纸巾」→ null', '帮我买两包纸巾', null);
parserCheck('P8 状态陈述「面巾纸用完了」→ null', '面巾纸用完了', null);

/* ---- Q 组：真实 UI 契约 ---------------------------------------------------
 * P 组只测 parser，而 parser 一直是对的 —— 「harness 全绿、真实 UI 仍追问
 * 价格/保质期」这个缺口它永远测不出来。Q 组走完整 route handler，断言前端
 * 真正拿到的东西：draft 终态、是否调用 LLM、确认/取消动作。
 */
const leftoverDraft: IngredientRecordDraft = {
  type: 'ingredient',
  status: 'confirming',
  data: { name: '牛奶', quantity: 1, unit: '盒', purchaseDate: '2026-03-14' },
  missingFields: []
};

/*
 * Q0 作废判定本身是纯函数，直接表驱动断言，不走 chat()。
 *
 * 混合表达（「不要了，改成3个」）若走整条链路，会掉进 parseConfirmation 的
 * rejected 分支去打 LLM，测到的就是网络通不通，而不是判得对不对。
 */
const DISCARD_CASES: [string, boolean][] = [
  ['取消', true], ['取消。', true], ['算了', true], ['算了啦', true],
  ['不要了', true], ['不添加了', true], ['作废', true], ['cancel', true],
  ['改成3个', false], ['不要了，改成3个', false], ['数量错了', false],
  ['重新填写', false], ['不，是3个', false], ['番茄', false], ['确认', false],
  ['不要番茄炒蛋', false]
];
for (const [phrase, expected] of DISCARD_CASES) {
  const got = isIngredientDraftDiscard(phrase);
  summary.push({
    label: `Q0 作废判定「${phrase}」→ ${got}`,
    pass: got === expected,
    detail: `期望 ${expected}，实际 ${got}`
  });
  realLog(
    `${got === expected ? 'PASS' : 'FAIL'}  Q0 作废判定「${phrase}」→ ${got}（期望 ${expected}）`
  );
}

aiCalls = 0;
await chat(
  'Q1 「今天买了2个番茄」→ confirming 卡片 + 零 LLM + 不追问价格/保质期',
  uiBody('今天买了2个番茄', null),
  (g) =>
    g.decision === 'add-inventory' &&
    g.draftStatus === 'confirming' &&
    g.aiCalls === 0 &&
    g.llmExtractCalls === 0 &&
    g.json.draft?.data?.name === '番茄' &&
    g.json.draft?.data?.quantity === 2 &&
    !/价格|保质期/.test(g.response ?? '')
);

aiCalls = 0;
await chat(
  'Q2 裸名「番茄」→ confirming 卡片 + 零 LLM',
  uiBody('番茄', null),
  (g) =>
    g.decision === 'add-inventory' &&
    g.draftStatus === 'confirming' &&
    g.aiCalls === 0 &&
    g.llmExtractCalls === 0 &&
    g.draftName === '番茄'
);

// 残留的是「牛奶」草稿：若被旧草稿劫持，draftName 就会是牛奶而不是番茄。
aiCalls = 0;
await chat(
  'Q3 残留草稿 + 「今天买了2个番茄」→ 不被旧草稿劫持，零 LLM',
  uiBody('今天买了2个番茄', null, leftoverDraft),
  (g) =>
    g.decision === 'add-inventory' &&
    g.draftStatus === 'confirming' &&
    g.aiCalls === 0 &&
    g.llmExtractCalls === 0 &&
    g.draftName === '番茄'
);

aiCalls = 0;
await chat(
  'Q4 确认卡上点「确认」→ SAVE_INGREDIENT，零 LLM',
  uiBody('确认', null, leftoverDraft),
  (g) =>
    g.decision === 'continue-draft' &&
    g.json.action === 'SAVE_INGREDIENT' &&
    g.json.ingredient?.name === '牛奶' &&
    g.aiCalls === 0 &&
    g.llmExtractCalls === 0 &&
    g.draftStatus === null
);

/*
 * Q5 → Q6 是一条真实的连续对话链。
 *
 * 前端下一轮发出的 currentDraft 就是上一轮服务端回传的 draft，
 * 所以这里把 Q5 的响应喂给 Q6，而不是手动传 null ——
 * 否则测的只是「测试自己没传草稿」，证明不了服务端真的作废了。
 */
aiCalls = 0;
const cancelled = await chat(
  'Q5 「取消」→ 直接作废食材草稿：零 LLM、不回传 draft、明确取消文案',
  uiBody('取消', null, leftoverDraft),
  (g) =>
    g.decision === 'continue-draft' &&
    g.aiCalls === 0 &&
    g.llmExtractCalls === 0 &&
    g.json.draft === undefined &&
    g.draftStatus === null &&
    g.json.intent === 'REALITY_RECORD' &&
    /已取消/.test(g.response ?? '') &&
    !/价格|保质期|还需要/.test(g.response ?? '')
);

aiCalls = 0;
await chat(
  'Q6 作废后下一句「明天帮我买包纸巾」→ 正常路由，不被旧草稿劫持',
  uiBody('明天帮我买包纸巾', null, cancelled?.draft ?? null),
  (g) =>
    g.taskType === 'add_shopping_item' &&
    g.aiCalls === 0 &&
    g.llmExtractCalls === 0 &&
    g.shopping.length === 1 &&
    g.shopping[0].startsWith('纸巾')
);

// 对照：作废词表不能误伤正常的修改意图，否则用户改个数量就丢掉了整条记录。
aiCalls = 0;
await chat(
  'Q7 对照「改成3个」→ 不作废，草稿原样保留',
  uiBody('改成3个', null, leftoverDraft),
  (g) =>
    g.aiCalls === 0 &&
    g.llmExtractCalls === 0 &&
    g.draftStatus === 'confirming' &&
    g.draftName === '牛奶' &&
    !/已取消/.test(g.response ?? '')
);

// 「算了 / 不要了」这类以「了」结尾的表达会被口令归一化剥掉语气词，
// 词表必须在归一化之后仍然命中，否则等于没收录。
for (const phrase of ['算了', '不要了', '不添加了', '作废']) {
  aiCalls = 0;
  await chat(
    `Q8 作废同义词「${phrase}」→ 零 LLM 直接作废`,
    uiBody(phrase, null, leftoverDraft),
    (g) =>
      g.aiCalls === 0 &&
      g.llmExtractCalls === 0 &&
      g.json.draft === undefined &&
      /已取消/.test(g.response ?? '')
  );
}

/* ------------------------------------------------------------------ *
 * F. 显式 Card Action（page.tsx 食材卡按钮实际发出的形状）
 *
 * Q 组测的是「用户在输入框里打字」，F 组测的是「用户点了按钮」：
 * 请求带 cardAction，message 只是气泡文案。两条路径必须写出同一条记录，
 * 但按钮这条额外要求 —— 它不许碰另一张卡的会话。
 *
 * 这里全部同时挂着 shoppingTask，就是为了盯住隔离性：
 * 点「取消牛奶」之后，正在等的采购会话必须原样还在。
 * ------------------------------------------------------------------ */

const INGREDIENT_CONFIRM: IngredientCardAction = { kind: 'ingredient', command: 'confirm' };
const INGREDIENT_CANCEL: IngredientCardAction = { kind: 'ingredient', command: 'cancel' };

// 会话快照必须在整轮里原样带回：草稿条目一条不少，阶段一条不变
const sessionIntact = (g: any) =>
  g.json.activeTask?.taskType === 'add_shopping_item' &&
  g.json.activeTask?.shoppingDrafts?.length === 1 &&
  g.json.activeTask?.shoppingDrafts?.[0]?.name === '纸巾';

aiCalls = 0;
await chat(
  'F1 按钮「确认加入」→ SAVE_INGREDIENT 完整字段 + 零 LLM + 不结束采购会话',
  uiBody('确认', shoppingTask, leftoverDraft, INGREDIENT_CONFIRM),
  (g) =>
    g.aiCalls === 0 &&
    g.llmExtractCalls === 0 &&
    g.json.action === 'SAVE_INGREDIENT' &&
    g.json.ingredient?.name === '牛奶' &&
    g.json.ingredient?.quantity === '1' &&
    g.json.ingredient?.unit === '盒' &&
    g.json.ingredient?.category === '其他' &&
    g.json.ingredient?.purchaseDate === '2026-03-14' &&
    // 未提供的字段落成空串/默认值，绝不能落成字符串 "undefined"
    g.json.ingredient?.expiryDate === '' &&
    g.json.ingredient?.storageLocation === '冷藏' &&
    g.json.draft === undefined &&
    sessionIntact(g)
);

aiCalls = 0;
await chat(
  'F2 按钮「取消」→ 不写入、作废草稿、采购会话原样保留',
  uiBody('取消', shoppingTask, leftoverDraft, INGREDIENT_CANCEL),
  (g) =>
    g.aiCalls === 0 &&
    g.llmExtractCalls === 0 &&
    g.json.action === undefined &&
    g.json.draft === undefined &&
    /已取消/.test(g.response ?? '') &&
    sessionIntact(g)
);

/*
 * F3 是 F1/F2 的对照组，也是这组测试存在的理由：
 * 同样一句「确认」，不带 cardAction 时服务端无法知道用户指的是哪张卡，
 * 必须停下来问，而不是按优先级替用户写进冰箱。
 * 少了这条断言，按钮换成纯文字也「看起来能用」，歧义会被静默吞掉。
 */
aiCalls = 0;
await chat(
  'F3 对照：两张卡同时挂着时打字「确认」→ 停下来问，不写入，两张卡都不消失',
  uiBody('确认', shoppingTask, leftoverDraft),
  (g) =>
    g.aiCalls === 0 &&
    g.llmExtractCalls === 0 &&
    g.json.action === undefined &&
    /哪一个/.test(g.response ?? '') &&
    /牛奶/.test(g.response ?? '') &&
    /纸巾/.test(g.response ?? '') &&
    g.draftStatus === 'confirming' &&
    sessionIntact(g)
);

// 只有一张卡时，纯文字口令必须照旧工作 —— 歧义保护不能变成新的拦截层
aiCalls = 0;
await chat(
  'F4 对照：只有食材卡时打字「确认」→ 照常 SAVE_INGREDIENT',
  uiBody('确认', null, leftoverDraft),
  (g) =>
    g.aiCalls === 0 &&
    g.llmExtractCalls === 0 &&
    g.json.action === 'SAVE_INGREDIENT' &&
    g.json.ingredient?.name === '牛奶' &&
    g.json.activeTask === undefined
);

/*
 * F5：卡片是消息里的旧快照（重复点击 / 刷新后残留）时，服务端手里已经没有
 * 这条草稿。此时唯一正确的动作是什么都不写 —— 拿 currentDraft 之外的数据
 * 凑一条记录，就是凭空造库存。
 */
aiCalls = 0;
await chat(
  'F5 快照过期：按钮 confirm 但服务端无草稿 → 不写入，卡片收敛',
  uiBody('确认', shoppingTask, undefined, INGREDIENT_CONFIRM),
  (g) =>
    g.aiCalls === 0 &&
    g.llmExtractCalls === 0 &&
    g.json.action === undefined &&
    g.json.draft === undefined &&
    /已经处理过/.test(g.response ?? '') &&
    sessionIntact(g)
);

/* ------------------------------------------------------------------
 * RB 组：一句话批量冰箱录入（P0.5-1）
 *
 * 三层各证一段，不越层：
 *   RB1-RB8  解析器 / Router 纯函数 —— 名单进得来、问句拦得住、坏名不再吞；
 *   RB9      route 级：支持句 → 5 行草稿，LLM 零调用；
 *   RB10-12  整组确认 / 整组取消 / 缺行不写 —— drafts 快照往返，
 *            且与 F2/F5 同源：操作批量卡不得结束采购会话。
 * ------------------------------------------------------------------ */

function batchParserCheck(label: string, message: string, expectNames: string[] | null) {
  const got = tryParseInventoryRecords(message);
  const pass =
    expectNames === null
      ? got === null
      : !!got &&
        got.length === expectNames.length &&
        got.every((item, i) => item.name === expectNames[i]);
  summary.push({ label, pass, detail: JSON.stringify(got) });
  realLog(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
  if (!pass) realLog(`      ${JSON.stringify(got)}`);
}

const FRIDGE_BATCH_SENTENCE =
  '我现在冰箱里有牛肉、豌豆、鸡蛋、西红柿、洋葱，帮我加进冰箱';

batchParserCheck(
  'RB1 「我现在冰箱里有牛肉、豌豆、鸡蛋、西红柿、洋葱，帮我加进冰箱」→ 5 行',
  FRIDGE_BATCH_SENTENCE,
  ['牛肉', '豌豆', '鸡蛋', '西红柿', '洋葱']
);
batchParserCheck('RB2 裸清单「牛肉、豌豆、鸡蛋」→ 3 行', '牛肉、豌豆、鸡蛋', ['牛肉', '豌豆', '鸡蛋']);
batchParserCheck(
  'RB3 「今天我买了2斤牛肉、三盒鸡蛋」→ 2 行且名称剥离数量',
  '今天我买了2斤牛肉、三盒鸡蛋',
  ['牛肉', '鸡蛋']
);
batchParserCheck('RB4 带疑问词的清单句 → null（交回分类器）', '冰箱里还有什么？我想做意大利面', null);
batchParserCheck('RB5 是非问句「我有牛肉吗」→ null', '我有牛肉吗', null);
batchParserCheck('RB6 纯动作句无名单「帮我加进冰箱」→ null', '帮我加进冰箱', null);

// 坏名修复的反证：批量归批量，单条解析器遇到清单必须弃权，
// 不能再把「牛肉、豌豆」整串吞成一条食材名（P0 验收时确认的老 bug）。
const rbBadName = tryParseInventoryRecord('今天买了牛肉、豌豆');
summary.push({
  label: 'RB7 单条解析器不再吞清单：tryParseInventoryRecord("今天买了牛肉、豌豆") → null',
  pass: rbBadName === null,
  detail: JSON.stringify(rbBadName)
});
realLog(`${rbBadName === null ? 'PASS' : 'FAIL'}  RB7`);

// Router 疑问守卫：同一批词面，陈述 / 疑问必须走向相反。
const rbGuardPass =
  routeAITask({ message: '我现在冰箱里有牛肉、豌豆，帮我加进冰箱' }).intent?.taskType ===
    'add_inventory' &&
  routeAITask({ message: '我们冰箱里还有什么？我想做意大利面' }).intent?.taskType !==
    'add_inventory' &&
  routeAITask({ message: '我有牛肉吗' }).intent?.taskType !== 'add_inventory';
summary.push({
  label: 'RB8 router 守卫：陈述 → add_inventory，问句 ≠ add_inventory',
  pass: rbGuardPass,
  detail: 'guard 判定'
});
realLog(`${rbGuardPass ? 'PASS' : 'FAIL'}  RB8`);

// route 级：支持句整链
aiCalls = 0;
llmExtractCalls = 0;
const rb9 = await chat(
  `RB9 route 级「${FRIDGE_BATCH_SENTENCE}」→ add-inventory 直通，5 行 confirming 草稿，LLM 零调用`,
  uiBody(FRIDGE_BATCH_SENTENCE, null),
  (g) =>
    g.decision === 'add-inventory' &&
    g.json.intent === 'REALITY_RECORD' &&
    Array.isArray(g.json.drafts) &&
    g.json.drafts.length === 5 &&
    g.json.drafts.map((d: IngredientRecordDraft) => d.data.name).join(',') ===
      '牛肉,豌豆,鸡蛋,西红柿,洋葱' &&
    g.json.drafts.every((d: IngredientRecordDraft) => d.status === 'confirming') &&
    g.aiCalls === 0 &&
    g.llmExtractCalls === 0
);

// chat() 返回的就是响应体本身（json），没有 .json 包装层
const rbDrafts: IngredientRecordDraft[] = rb9.drafts ?? [];
await chat(
  'RB10 整组确认：SAVE_INGREDIENTS 一次回 5 条 ingredients，activeTask 原样回传，LLM 零调用',
  { ...uiBody('确认', shoppingTask, undefined, INGREDIENT_CONFIRM), drafts: rbDrafts },
  (g) =>
    g.json.action === 'SAVE_INGREDIENTS' &&
    Array.isArray(g.json.ingredients) &&
    g.json.ingredients.length === 5 &&
    g.json.ingredients.map((r: { name: string }) => r.name).join(',') ===
      '牛肉,豌豆,鸡蛋,西红柿,洋葱' &&
    g.json.ingredients.every((r: { purchaseDate?: string }) => !!r.purchaseDate) &&
    g.json.activeTask?.taskType === 'add_shopping_item' &&
    g.json.activeTask?.shoppingDrafts?.length === shoppingTask.shoppingDrafts.length &&
    g.aiCalls === 0 &&
    g.llmExtractCalls === 0
);

await chat(
  'RB11 整组取消：回取消文案（不得是「这条记录已经处理过了」），无 action，会话保留',
  { ...uiBody('取消', shoppingTask, undefined, INGREDIENT_CANCEL), drafts: rbDrafts },
  (g) =>
    /已取消/.test(g.response) &&
    !g.json.action &&
    g.json.activeTask?.shoppingDrafts?.length === shoppingTask.shoppingDrafts.length &&
    sessionIntact(g)
);

// 半途烂尾防线：任何一行没补齐 → 整组不写（存一半是最难收拾的状态）
const rbHalfBroken = rbDrafts.map((d, i) =>
  i === 2 ? { ...d, status: 'collecting' as const, data: { ...d.data, name: '' } } : d
);
await chat(
  'RB12 一行缺名 → 整组不写：无 action，回复要求先补齐',
  { ...uiBody('确认', null, undefined, INGREDIENT_CONFIRM), drafts: rbHalfBroken },
  (g) => !g.json.action && /补/.test(g.response)
);

/* ------------------------------------------------------------------
 * RB13 起：P0.5-1 的验收口径。
 *
 * RB13  用户逐条确认过的四句话，route 级整链（Router 判定 → 批量解析 → 多行草稿）
 *       全部零 LLM —— 证明共享正则真的只有一条，且撑得住这几种说法。
 * RB14  同一批词面的反证：问句不进门，动作残留不许变成食材名。
 * RB15  共享守卫的自洽校验：整张词表必须同时不被残留守卫和尾句守卫误伤，
 *       以后往词表里加词，撞上守卫会立刻红。
 * ------------------------------------------------------------------ */

const CONFIRM_PHRASES: [string, string[]][] = [
  ['牛肉、豌豆、鸡蛋、西红柿、洋葱', ['牛肉', '豌豆', '鸡蛋', '西红柿', '洋葱']],
  ['牛肉和豌豆', ['牛肉', '豌豆']],
  ['牛肉、鸡蛋和西红柿', ['牛肉', '鸡蛋', '西红柿']],
  ['我买了牛肉和豌豆，帮我放进冰箱', ['牛肉', '豌豆']]
];

for (const [phrase, names] of CONFIRM_PHRASES) {
  aiCalls = 0;
  llmExtractCalls = 0;
  await chat(
    `RB13 验收句「${phrase}」→ ${names.length} 行 confirming 草稿，LLM 零调用`,
    uiBody(phrase, null),
    (g) =>
      g.decision === 'add-inventory' &&
      Array.isArray(g.json.drafts) &&
      g.json.drafts.length === names.length &&
      g.json.drafts.map((d: IngredientRecordDraft) => d.data.name).join(',') ===
        names.join(',') &&
      g.json.drafts.every((d: IngredientRecordDraft) => d.status === 'confirming') &&
      g.aiCalls === 0 &&
      g.llmExtractCalls === 0
  );
}

// 「牛肉，放进冰箱」：单项 + 动作分句也要成行，但不能报成 null 让整句掉回 LLM
batchParserCheck('RB14a 「牛肉，放进冰箱」→ 1 行', '牛肉，放进冰箱', ['牛肉']);
batchParserCheck('RB14b 「牛肉、豌豆，明天再放进冰箱」→ 2 行（时间状语随尾句剥掉）', '牛肉、豌豆，明天再放进冰箱', ['牛肉', '豌豆']);
batchParserCheck('RB14c 残留守卫：「牛肉、豌豆记得放冰箱」→ null', '牛肉、豌豆记得放冰箱', null);
batchParserCheck('RB14d 残留守卫：「西红柿和鸡蛋怎么做」→ null', '西红柿和鸡蛋怎么做', null);
// 「五」既是数字又是菜名的一部分：词表优先，绝不剥成「花肉」
batchParserCheck(
  'RB14e 「我买了五花肉、牛肉」→ 2 行且名称完整',
  '我买了五花肉、牛肉',
  ['五花肉', '牛肉']
);

const rb14GuardPass =
  // 同一批词面，问句必须挡在门外（陈述/疑问走向相反）
  routeAITask({ message: '牛肉和豌豆' }).intent?.taskType === 'add_inventory' &&
  routeAITask({ message: '牛肉和豌豆买了吗' }).intent?.taskType !== 'add_inventory' &&
  routeAITask({ message: '西红柿和鸡蛋怎么做' }).intent?.taskType !== 'add_inventory' &&
  !!bareIngredientListNames('牛肉、鸡蛋和西红柿') &&
  !bareIngredientListNames('牛肉和豌豆买了吗') &&
  !bareIngredientListNames('帮我把牛肉和豌豆放进冰箱');
summary.push({
  label: 'RB14 router 守卫：裸名单进得来，问句与整句祈使挡得住',
  pass: rb14GuardPass,
  detail: 'bare-list + question guard'
});
realLog(`${rb14GuardPass ? 'PASS' : 'FAIL'}  RB14`);

// 词表 × 守卫互斥：任一食材名被残留守卫或尾句守卫吃掉，都是误伤
const rbVocabResidueHits = FRESH_INGREDIENT_NAMES.filter((n) =>
  INGREDIENT_ACTION_RESIDUE_RE.test(n)
);
const rbVocabTailHits = FRESH_INGREDIENT_NAMES.filter((n) => FRIDGE_ACTION_TAIL_RE.test(n));
const rbVocabParseHits = FRESH_INGREDIENT_NAMES.filter(
  (n) => tryParseInventoryRecord(n)?.name !== n
);
// 名单条目路径同一次校验：「五花肉、牛肉」不许把「五」当数量剥掉
const rbVocabListHits = FRESH_INGREDIENT_NAMES.filter(
  (n) => tryParseInventoryRecords(`${n}、豌豆`)?.[0]?.name !== n
);
summary.push({
  label: `RB15 词表 ${FRESH_INGREDIENT_NAMES.length} 词 × 共享守卫互斥（残留/尾句/裸名/名单条目）`,
  pass:
    rbVocabResidueHits.length === 0 &&
    rbVocabTailHits.length === 0 &&
    rbVocabParseHits.length === 0 &&
    rbVocabListHits.length === 0,
  detail: `残留误伤=${JSON.stringify(rbVocabResidueHits)} 尾句误伤=${JSON.stringify(
    rbVocabTailHits
  )} 裸名解析失败=${JSON.stringify(rbVocabParseHits.slice(0, 8))} 名单解析失败=${JSON.stringify(
    rbVocabListHits.slice(0, 8)
  )}`
});
realLog(
  `${rbVocabResidueHits.length === 0 &&
    rbVocabTailHits.length === 0 &&
    rbVocabParseHits.length === 0 &&
    rbVocabListHits.length === 0
    ? 'PASS'
    : 'FAIL'
  }  RB15`
);

/* ------------------------------------------------------------------
 * PC 组：P0.5-3 Bug 1 —— 采购完成 → 入厨房确认（route 级）
 *
 * 翻车原句：「我把盐和食用油都买回来了，现在可以开始做了」。盐和油确实都在
 * 消耗品词表里，旧路由于是追问「放哪里 / 多久用完」—— 用户报的是到手，
 * 不是请系统建档。这一组锁死判据的两端：说法 + 清单证据齐全才抢，
 * 缺证据就绝不凭空造入库卡。落盘那一半在 storage-harness 的 P0_5_3 组。
 * ------------------------------------------------------------------ */

const TODAY = new Date().toISOString().split('T')[0];

/** 只造清单形状：complete_purchase 认的是 name / status / restockedAt 三件事 */
const pcList = (
  items: Array<{ id: string; name: string; status?: string; restockedAt?: string }>
) => [
  {
    id: 'pc_list',
    title: '今晚买菜',
    createdAt: TODAY,
    items: items.map((item) => ({
      id: item.id,
      name: item.name,
      status: item.status ?? 'pending',
      source: 'manual',
      createdAt: TODAY,
      ...(item.restockedAt ? { restockedAt: item.restockedAt } : {})
    }))
  }
];

const RESTOCK_SENTENCE = '我把盐和食用油都买回来了，现在可以开始做了';
// 食盐、食用油都是已建档消耗品：旧 bug 正是被这两个名字带进消耗品录入的
const pcConsumables = [
  { id: 'pc_c1', name: '食盐', quantity: 1, unit: '袋', status: 'estimated', estimatedRunOutDays: 30, checkIntervalDays: 7, createdAt: TODAY, updatedAt: TODAY },
  { id: 'pc_c2', name: '食用油', quantity: 1, unit: '瓶', status: 'estimated', estimatedRunOutDays: 60, checkIntervalDays: 7, createdAt: TODAY, updatedAt: TODAY }
];
const pcBody = (shoppingLists: unknown) => ({
  message: RESTOCK_SENTENCE,
  ingredients: [],
  consumables: pcConsumables,
  shoppingLists
});

const pc1 = await chat(
  'PC1 「我把盐和食用油都买回来了，现在可以开始做了」+ 清单上有盐/食用油 → complete_purchase，不进 REALITY_RECORD_CONSUMABLE',
  pcBody(pcList([{ id: 'pc_i1', name: '盐' }, { id: 'pc_i2', name: '食用油' }])),
  (g) =>
    g.taskType === 'complete_purchase' &&
    g.json.intent !== 'REALITY_RECORD_CONSUMABLE' &&
    !g.json.task?.consumableDrafts &&
    g.json.drafts?.length === 2 &&
    g.json.drafts.map((d: IngredientRecordDraft) => d.data.name).join(',') === '盐,食用油' &&
    // 入库草稿整组挂既有冰箱卡通道：confirming 且一行都没问「多久用完 / 放哪里」
    g.json.drafts.every(
      (d: IngredientRecordDraft) => d.status === 'confirming' && d.missingFields.length === 0
    ) &&
    g.json.restockAnchors?.map((a: { listId: string; itemId: string }) => `${a.listId}/${a.itemId}`).join(',') ===
      'pc_list/pc_i1,pc_list/pc_i2' &&
    g.aiCalls === 0 &&
    g.llmExtractCalls === 0
);

// 反证：清单上一条都对不上 → 不许凭空造入库卡（此时退回原有路由是正确行为）
await chat(
  'PC2 清单为空 → 不出 restockAnchors、不判 complete_purchase（宁可少抢一次）',
  pcBody([]),
  (g) =>
    g.taskType !== 'complete_purchase' &&
    !g.json.restockAnchors &&
    !g.json.drafts
);

await chat(
  'PC3 清单上只有盐 → 只出 1 行，食用油绝不跟着冒出来',
  pcBody(pcList([{ id: 'pc_i1', name: '盐' }, { id: 'pc_i3', name: '酱油' }])),
  (g) =>
    g.taskType === 'complete_purchase' &&
    g.json.drafts?.length === 1 &&
    g.json.drafts[0].data.name === '盐' &&
    g.json.restockAnchors?.length === 1 &&
    g.json.restockAnchors[0].itemId === 'pc_i1'
);

// 幂等锚点：确认过的条目不能第二次出卡（与采购清单页勾选同一条规则）
await chat(
  'PC4 清单上盐已入库（restockedAt 有值）→ 不再抢，也不重复出卡',
  pcBody(pcList([{ id: 'pc_i1', name: '盐', restockedAt: TODAY }, { id: 'pc_i2', name: '食用油' }])),
  (g) =>
    g.taskType === 'complete_purchase' &&
    g.json.drafts?.map((d: IngredientRecordDraft) => d.data.name).join(',') === '食用油' &&
    g.json.restockAnchors?.length === 1 &&
    g.json.restockAnchors[0].itemId === 'pc_i2'
);

// 勾选过（purchased）但还没入库的条目同样算「到手」；取消勾选（pending 且无标记）也算。
// 这里锁 purchased 这一支，防止 readRestockTargets 以后被改成只认某一种状态。
await chat(
  'PC5 清单条目 status=purchased 未入库 → 仍是采购完成候选',
  pcBody(pcList([{ id: 'pc_i1', name: '盐', status: 'purchased' }])),
  (g) =>
    g.taskType === 'complete_purchase' &&
    g.json.restockAnchors?.length === 1 &&
    g.json.restockAnchors[0].itemId === 'pc_i1'
);

/* PC6 前端接线：POST 级用例只证明「router 认得这个形状」，证明不了 page.tsx
 * 真会把清单发出去、route.ts 真会把它交给 router。清单这条数据两头都不能靠猜。 */
const pageSrcPc = readFileSync(join(process.cwd(), 'src/app/page.tsx'), 'utf-8');
const routeSrcPc = readFileSync(join(process.cwd(), 'src/app/api/ai/chat/route.ts'), 'utf-8');
const pc6Pass =
  // 发送瞬间现读 storage，不用 React state 里那份旧快照
  /const shoppingListsSnapshot = getShoppingLists\(\);/.test(pageSrcPc) &&
  /shoppingLists: shoppingListsSnapshot/.test(pageSrcPc) &&
  // 锚点在写入成功之后才落，且两条入库分支（单条 / 整组）都要收
  /markRestockedAnchors\(hostMessageId\)/.test(pageSrcPc) &&
  (pageSrcPc.match(/markRestockedAnchors\(hostMessageId\)/g) ?? []).length === 2 &&
  pageSrcPc.includes("from '@/lib/reality/shopping-lists'") &&
  // route.ts 把清单透传给 taskContext
  /shoppingLists: safeShoppingLists/.test(routeSrcPc);
summary.push({
  label: 'PC6 接线：page.tsx 现读清单发送 / route.ts 透传 taskContext / 两条入库分支都收锚点',
  pass: pc6Pass,
  detail: `snapshot=${/shoppingListsSnapshot/.test(pageSrcPc)} anchors=${(pageSrcPc.match(/markRestockedAnchors\(hostMessageId\)/g) ?? []).length}/2 taskContext=${/shoppingLists: safeShoppingLists/.test(routeSrcPc)}`
});
realLog(`${pc6Pass ? 'PASS' : 'FAIL'}  PC6`);
if (!pc6Pass) realLog(`      ${`snapshot=${/shoppingListsSnapshot/.test(pageSrcPc)} anchors=${(pageSrcPc.match(/markRestockedAnchors\(hostMessageId\)/g) ?? []).length}/2 taskContext=${/shoppingLists: safeShoppingLists/.test(routeSrcPc)}`}`);

// PC7 Router 层优先级：同一句「买回来了」，有清单证据走采购完成，无证据才归消耗品录入
{
  const withList = routeAITask({
    message: RESTOCK_SENTENCE,
    consumables: pcConsumables as never,
    shoppingLists: pcList([{ id: 'pc_i1', name: '盐' }, { id: 'pc_i2', name: '食用油' }]) as never
  });
  const withoutList = routeAITask({
    message: RESTOCK_SENTENCE,
    consumables: pcConsumables as never,
    shoppingLists: [] as never
  });
  const pc7Pass =
    withList.intent.taskType === 'complete_purchase' &&
    withoutList.intent.taskType !== 'complete_purchase';
  summary.push({
    label: 'PC7 router 判定唯一分叉：清单证据 → complete_purchase，无证据退回原路',
    pass: pc7Pass,
    detail: `with=${withList.intent.taskType} without=${withoutList.intent.taskType}`
  });
  realLog(`${pc7Pass ? 'PASS' : 'FAIL'}  PC7`);
}

// ---------------------------------------------------------------------------
// P0.5-3 Bug 2：高置信做饭能力查询 —— 打断低优先级会话 + 确定式进库存链路
//
//   CC1..CC6  路由层：进行中的消耗品会话在场时，六句查询全部判成 chat。
//             旧路由会把它们吞成「你在回答存放位置」（T9 那条追问），
//             CC5 更会被「刚买 + 食用油」整句拽进建档。
//   CC7/CC10  购物请求不得被 cooking query 抢走 —— 「买」不是做饭信号。
//   CC8       Bug 1 优先级回归：采购完成说法仍先命中 complete_purchase。
//   CC11      陈述式旁路的成立不依赖 RECORD_QUESTION_GUARD_RE。
//   CC12      反证：CC5 确实会被建档判据接走，抢回来才有意义。
//   CC9       endpoint 层：真发一次 POST /api/ai/chat，读真实库存出 recipeMatches，
//             且 classifyIntent 零调用。
// ---------------------------------------------------------------------------
realLog('\n=== P0.5-3 Bug 2 做饭能力查询 ===');

// 与 PC 组的 TODAY 同一写法，只服务测试：正数=未过期，负数=已购入。
const isoDate = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().split('T')[0];

// 路由层不读 context.ingredients（全量 grep 无引用），这份夹具只为把「库里确有存货」
// 这个真人场景的形状传进去 —— 做饭能力查询该拿库存出建议，而不是在空库存下才成立。
const ccIngredients = [
  { id: 'cc_r_tomato', name: '番茄', quantity: 2, unit: '个', purchaseDate: isoDate(-1), expiryDate: isoDate(4) },
  { id: 'cc_r_egg', name: '鸡蛋', quantity: 3, unit: '个', purchaseDate: isoDate(-1), expiryDate: isoDate(6) }
];

// routeAITask 的草稿一律对象包装（add_shopping/add_consumable/complete_purchase 都是
// { items }，状态更新是 { updates }），detail 里要读名字就得先拆开。
const draftNames = (drafts: unknown): string[] =>
  (((drafts ?? {}) as { items?: Array<{ name?: string }> }).items ?? []).map((d) => d.name ?? '?');

// 与 chat() 同样的记账方式：进 summary + 立刻打一行。route 级用例不必绕 endpoint。
const ccCase = (label: string, pass: boolean, detail: string) => {
  summary.push({ label, pass, detail });
  realLog(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
  if (!pass) realLog(`      ${detail}`);
};

// 与 T9 同一份会话快照：phase=collecting 意味着路由第 4 步本来会接着追问存放位置。
const ccSession = collectingTask();

const ccQueryCases: Array<{ id: string; msg: string; note: string }> = [
  { id: 'CC1', msg: '我现在可以做什么了', note: '疑问式，无宾语' },
  { id: 'CC2', msg: '有什么可以吃', note: '疑问式，拿库存换一顿饭' },
  { id: 'CC3', msg: '帮我看看现在能做什么', note: '疑问式，帮我看看' },
  { id: 'CC4', msg: '根据现在的食材推荐一下', note: '疑问式，推荐' },
  { id: 'CC5', msg: '我刚买的食用油能做什么', note: '购买词 + 消耗品词表命中' },
  { id: 'CC6', msg: '看看现在能做的菜', note: '陈述式旁路：整句无疑问线索' }
];
for (const cc of ccQueryCases) {
  const routed = routeAITask({
    message: cc.msg,
    ingredients: ccIngredients,
    consumables,
    activeTask: ccSession
  } as never);
  const pred = isCookingCapabilityQuery(cc.msg);
  ccCase(
    `${cc.id} "${cc.msg}" 打断进行中的消耗品会话 → chat（${cc.note}）`,
    pred &&
      routed.intent.taskType === 'chat' &&
      routed.intent.confidence === 0.9 &&
      (routed.intent.reason ?? '').includes('做饭能力查询') &&
      routed.drafts === null,
    `activeTask=add_consumable(collecting) | pred=${pred} | taskType=${routed.intent.taskType} ` +
      `| conf=${routed.intent.confidence} | drafts=${routed.drafts === null ? 'null' : '非空'} ` +
      `| reason=${routed.intent.reason ?? '-'}`
  );
}

// CC7 / CC10：购物请求原样落回 add_shopping_item
{
  const msg = '帮我买包纸巾好吗';
  const routed = routeAITask({ message: msg, ingredients: ccIngredients, consumables } as never);
  const names = draftNames(routed.drafts);
  ccCase(
    `CC7 "${msg}" 仍是 add_shopping_item（未被 cooking query 抢走）`,
    routed.intent.taskType === 'add_shopping_item' && !isCookingCapabilityQuery(msg),
    `taskType=${routed.intent.taskType} | drafts=${names.length} (name=${names.join(',') || '-'}) ` +
      `| isCookingCapabilityQuery=${isCookingCapabilityQuery(msg)} | reason=${routed.intent.reason ?? '-'}`
  );
  ccCase(
    `CC10 "${msg}" 不因「买」被误判为做饭能力查询`,
    !isCookingCapabilityQuery(msg) && looksLikeAddShoppingItem(msg),
    `isCookingCapabilityQuery=${isCookingCapabilityQuery(msg)} | looksLikeAddShoppingItem=${looksLikeAddShoppingItem(msg)}`
  );
}

// CC8：采购完成的优先级不被第二刀动摇
{
  // pcList 已经返回 ShoppingList[]（与 PC 组同一份夹具），不再套一层数组
  const lists = pcList([
    { id: 's1', name: '盐' },
    { id: 'o1', name: '食用油' }
  ]);
  const routed = routeAITask({
    message: RESTOCK_SENTENCE,
    ingredients: [],
    consumables: pcConsumables,
    shoppingLists: lists
  } as never);
  // complete_purchase 的草稿是 { items }（清单条目 + listId），不是数组
  const names = draftNames(routed.drafts);
  ccCase(
    `CC8 "${RESTOCK_SENTENCE}" 仍是 complete_purchase（cooking guard 不得抢走）`,
    routed.intent.taskType === 'complete_purchase' &&
      names.length === 2 &&
      !isCookingCapabilityQuery(RESTOCK_SENTENCE),
    `taskType=${routed.intent.taskType} | names=${names.join(',')} ` +
      `| isCookingCapabilityQuery=${isCookingCapabilityQuery(RESTOCK_SENTENCE)}`
  );
}

// CC11：陈述式旁路不要求疑问守卫命中
{
  const msg = '看看现在能做的菜';
  const questionHit = RECORD_QUESTION_GUARD_RE.test(msg);
  const pred = isCookingCapabilityQuery(msg);
  ccCase(
    `CC11 "${msg}" 不依赖 RECORD_QUESTION_GUARD_RE 也成立`,
    !questionHit && pred,
    `RECORD_QUESTION_GUARD_RE=${questionHit} | isCookingCapabilityQuery=${pred}`
  );
}

// CC12：反证 —— 这句本来会被建档判据整句接走
{
  const msg = '我刚买的食用油能做什么';
  const consumableHit = looksLikeAddConsumable(msg);
  const routed = routeAITask({
    message: msg,
    ingredients: ccIngredients,
    consumables,
    activeTask: ccSession
  } as never);
  ccCase(
    `CC12 "${msg}" 确实会被建档接走 → 现由 cooking query 截断`,
    consumableHit && isCookingCapabilityQuery(msg) && routed.intent.taskType === 'chat',
    `looksLikeAddConsumable=${consumableHit} | isCookingCapabilityQuery=${isCookingCapabilityQuery(msg)} | taskType=${routed.intent.taskType}`
  );
}

// CC9：endpoint 层。名称精确匹配，故用词表里的写法（「番茄」而非「西红柿」）。
{
  const kitchen = [
    { id: 'cc-tomato', name: '番茄', quantity: '2', unit: '个', category: 'vegetable', purchaseDate: isoDate(-1), expiryDate: isoDate(4), storageLocation: 'fridge' },
    { id: 'cc-egg', name: '鸡蛋', quantity: '3', unit: '个', category: 'protein', purchaseDate: isoDate(-1), expiryDate: isoDate(6), storageLocation: 'fridge' },
    { id: 'cc-beef', name: '牛肉', quantity: '200', unit: 'g', category: 'protein', purchaseDate: isoDate(-1), expiryDate: isoDate(2), storageLocation: 'fridge' },
    { id: 'cc-pea', name: '豌豆', quantity: '1', unit: '把', category: 'vegetable', purchaseDate: isoDate(-1), expiryDate: isoDate(3), storageLocation: 'fridge' },
    { id: 'cc-onion', name: '洋葱', quantity: '1', unit: '个', category: 'vegetable', purchaseDate: isoDate(-2), expiryDate: isoDate(7), storageLocation: 'shelf' }
  ];
  const kitchenNames = new Set(kitchen.map((i) => i.name));

  // classifier 桩：一旦被调用就计数并回一个明显不对的意图 ——
  // 断言靠「结果错」失败，而不是靠离线环境的网络超时「感觉」它没被调用。
  const originalClassify = (intentService as any).classifyIntent;
  let classifyCalls = 0;
  (intentService as any).classifyIntent = async () => {
    classifyCalls += 1;
    return { intent: 'LIFE_SOLUTION', requiredData: [] };
  };
  aiReplyStub = '锅里有番茄和鸡蛋，先炒一盘番茄炒鸡蛋；牛肉配豌豆还能加个菜。';
  let cc9Detail = '';
  try {
    await chat(
      'CC9 "我现在可以做什么了" endpoint → REALITY_QUERY + 真实库存食谱（classifier 零调用）',
      { message: '我现在可以做什么了', ingredients: kitchen, consumables, reminders: [], myRecipes: [] },
      (got) => {
        const json = got.json as
          | {
              error?: string;
              intent?: string;
              requiredData?: string[];
              recipeMatches?: Array<{
                title: string;
                availableIngredients: string[];
                missingIngredients: string[];
                matchScore: number;
              }>;
            }
          | undefined;
        const matches = json?.recipeMatches ?? [];
        const first = matches[0];
        cc9Detail =
          `decision=${got.decision} | intent=${json?.intent} | requiredData=${JSON.stringify(json?.requiredData ?? [])} ` +
          `| classify=${classifyCalls} | ai=${got.aiCalls} | extract=${got.llmExtractCalls} ` +
          `| matches=${matches.length} | top=${first ? `${first.title}:${first.availableIngredients.join('+')}→${first.matchScore}分` : '-'} ` +
          `| promptHasFridge=${aiSystemPrompt.includes('【用户真实冰箱数据】')}`;
        return (
          json?.error === undefined &&
          json?.intent === 'REALITY_QUERY' &&
          (json?.requiredData ?? []).includes('ingredients') &&
          classifyCalls === 0 &&
          matches.length > 0 &&
          !!first &&
          first.availableIngredients.length > 0 &&
          first.availableIngredients.every((n) => kitchenNames.has(n)) &&
          matches.every((m) => m.availableIngredients.every((n) => kitchenNames.has(n))) &&
          got.decision === 'fallback' &&
          got.aiCalls === 1 &&
          got.llmExtractCalls === 0 &&
          aiSystemPrompt.includes('【用户真实冰箱数据】')
        );
      }
    );
    realLog(`      ${cc9Detail}`);
    realLog('      说明：classifyIntent 与末句措辞为 harness 桩，意图判定/库存读取/食谱匹配全部走真实代码');
  } finally {
    (intentService as any).classifyIntent = originalClassify;
    aiReplyStub = null;
    aiSystemPrompt = '';
  }
}

// ---- 汇总 ---------------------------------------------------------------
const failed = summary.filter((s) => !s.pass);
realLog(`\n=== ${summary.length - failed.length}/${summary.length} 通过 ===`);
if (failed.length > 0) {
  realLog('失败详情：');
  for (const f of failed) realLog(`- ${f.label}\n  ${f.detail}`);
  process.exitCode = 1;
}
}

main().catch((err) => {
  realLog(`Harness 异常终止: ${(err as Error).stack ?? String(err)}`);
  process.exitCode = 1;
});