/**
 * add_consumable Task — 消耗品录入
 *
 * 关键区别于 add_inventory：
 * - Consumable 关注"多久用完"，不是"什么时候过期"
 * - 强关键字：面巾纸/纸巾/卫生纸/洗衣液/洗洁精/垃圾袋/牙膏/洗发水/沐浴露/生抽/老抽/蚝油/味精/食用油
 * - 必须先提取 name/qty/unit，再进入多轮收集（location + run_out/check_interval）
 * - 绝不直接写 localStorage；通过 Reality Service 提交
 */

import type {
  AITaskContext,
  AITaskExtraction,
  ConsumableDraft,
  ConsumableStatusUpdate,
  ShoppingItemDraft
} from './types';
import type { ConsumableItem } from '@/lib/types/consumable';
import { PURCHASE_LEAD_DAYS } from '@/lib/reality/reminder-engine';
import { parseChineseNumber } from './shopping-task';
import {
  applyConsumableSessionReply,
  mergeConsumableDrafts
} from './consumable-session';
import { isNegatedPurchase, readPurchaseCancellation } from './action-guard';

const CONSUMABLE_NAMES = [
  '面巾纸','纸巾','卫生纸','抽纸','卷纸',
  '洗衣液','洗洁精','洗衣粉',
  '垃圾袋','垃圾桶',
  '牙膏','牙刷','洗发水','沐浴露',
  '生抽','老抽','蚝油','味精','食盐','糖','醋','香油','料酒',
  '食用油','菜籽油','花生油','橄榄油',
  '洗面奶','护肤品','护手霜',
  '卫生巾','卫生纸',
  '洗手液','消毒液',
  '剃须刀','毛巾','拖鞋',
  '纸巾','抽纸'
];

const BOUGHT_KEYWORDS = ['买了','新买','刚买','购买了','采购了','囤了','补货','入了','入手了','入手','买回来','买回'];

function isConsumableName(text: string): boolean {
  const lower = text.toLowerCase();
  return CONSUMABLE_NAMES.some((name) => lower.includes(name));
}

function splitPhrases(message: string): string[] {
  return message
    .split(
      // 「还有」既是并列连接词（…还有垃圾袋），也是余量倒计时的开头（还有3天用完）。
      // 后面紧跟时间量词时不切分，否则「面巾纸还有3天用完」会被切成两半谁都对不上。
      /[、，；\n]|(?:和|以及|与)|还有(?!\s*(?:\d+|[一二两三四五六七八九十]+)\s*(?:天|日|周|星期))/g
    )
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 剥离「时间前缀 + 主语 + 购买动词」，得到纯「数量 + 单位 + 名称」片段。
 * 三类前缀可叠加（今天 + 刚刚 + 买了），因此循环剥离直到稳定。
 */
const SEGMENT_PREFIX_RE =
  /^(?:今天|昨天|前天|刚刚|刚才|今早|早上|上午|中午|下午|晚上)?(?:我们|我|你|她|他)?(?:买回来了|买回来|买回了|买了|买下|购买了|入手了|入手|新买|刚买|囤了|囤|采购了|补货|入了|加购|添加|买)了?\s*/;

function normalizeConsumableSegment(raw: string): string {
  let segment = raw.trim();
  for (let pass = 0; pass < 3; pass += 1) {
    const stripped = segment.replace(SEGMENT_PREFIX_RE, '').trim();
    if (stripped === segment) break;
    segment = stripped;
  }
  return segment;
}

/**
 * 「面巾纸放在储物室」里的位置描述不是物品名的一部分。
 * 不剥离就会产出 name =「面巾纸放在储物室」，而续采的 mergeConsumableDrafts
 * 按 name 精确去重，它不等于已有的「面巾纸」，于是被当成新物品 push ——
 * 2 个物品变 4 个。顺手把位置提取成 location，会话层就不必再从整句猜。
 */
const LOCATION_TAIL_RE =
  /(?:放在|放到|存放在|存放到|收纳在|收在|搁在|放)\s*([^，,。;；、\s]+)$/;

function splitNameAndLocation(
  segment: string
): { name: string; location?: string } {
  const m = segment.match(LOCATION_TAIL_RE);
  if (!m || m.index === undefined) return { name: segment };
  const name = segment.slice(0, m.index).trim();
  const location = m[1].replace(/[的了呢吧]+$/, '').trim();
  // 剥完没有物品名了（纯「放在储物室」），保留原文让上层判为无效片段
  if (!name || !location) return { name: segment };
  return { name, location };
}

function tryParse(nameStr: string): {
  name: string;
  quantity?: number;
  unit?: string;
  location?: string;
} | null {
  const segment = normalizeConsumableSegment(nameStr);
  if (!segment) return null;
  const match = segment.match(/^(\d+|[一二两三四五六七八九十]+)(?:\s*)(包|瓶|盒|袋|个|件|箱|罐|桶|kg|g|升|L)?(.+)?$/);
  if (match) {
    const quantity = parseChineseNumber(match[1]);
    const { name, location } = splitNameAndLocation((match[3] || '').trim());
    // 只有数量没有名称（如「1箱」）视为无效片段
    if (quantity === undefined || !name) return null;
    return {
      name,
      quantity,
      ...(match[2] ? { unit: match[2] } : {}),
      ...(location ? { location } : {})
    };
  }
  // 无数量：剥离位置描述后剩下的才是名称
  const { name, location } = splitNameAndLocation(segment);
  if (!name) return null;
  return { name, ...(location ? { location } : {}) };
}

/**
 * update_consumable_status Task — 消耗品余量 / 用完回写
 *
 * 输入示例：
 * - 「面巾纸用完了」        → used_up（urgent）
 * - 「洗衣液还剩两瓶」      → set_remaining（normal）
 * - 「生抽快用完了，不多了」→ running_low（soon）
 * - 「纸巾用完了，洗衣液还剩一瓶」→ 两条更新
 *
 * 输出 ConsumableStatusUpdate[]，requiresConfirmation = false：
 * 这是对用户已经明确陈述的事实的回写，不是新数据录入，因此不再二次确认。
 * 但绝不自动写入采购清单 —— 只在 replyText 里建议。
 */

/** 名称别名组：存储名与口语名不一致时仍能匹配（面巾纸 / 纸巾 / 抽纸） */
const NAME_ALIAS_GROUPS: string[][] = [
  ['面巾纸', '纸巾', '抽纸', '卫生纸', '卷纸', '纸'],
  ['洗衣液', '洗衣粉'],
  ['洗洁精', '洗碗液'],
  ['垃圾袋', '垃圾桶'],
  ['生抽', '老抽', '酱油'],
  ['食用油', '菜籽油', '花生油', '橄榄油'],
  ['洗发水', '洗发露'],
  ['沐浴露', '沐浴乳']
];

/**
 * 提问不是状态更新：「面巾纸还有多少？」应走查询而不是回写。
 * 注意不收「还能用」——「还能用5天」是陈述余量，疑问由 多久/几天/? 兜住。
 */
const QUESTION_RE = /[?？]|多少|几天|什么时候|够不够|用多久/;

/** 已用完 */
const USED_UP_RE = /用完了|用光|用尽|耗尽|没了|见底|空了|用掉/;
/** 即将用完（必须先于 USED_UP_RE 判断，「快用完了」也包含「用完」） */
const RUNNING_LOW_RE =
  /快用完了|快要没|快没|即将用完|马上用完|差不多用完|快用完|不多了|剩得不多|不多|该补|需要补|要补|最后一/;
/** 明确余量：还剩两瓶 / 还有3包 */
const REMAINING_RE =
  /(?:还剩|还有|剩下|留了)\s*(\d+|[一二两三四五六七八九十]+)\s*(包|瓶|盒|袋|个|件|箱|罐|桶|支|卷|提|kg|g|升|L)?/;

/**
 * 余量天数（必须先于 REMAINING_RE 判断）：
 * 「还有3天用完」「大概20天用完」「一周后就用完」「还能用5天」。
 * REMAINING_RE 的单位表里没有「天」，若不先拦下，「还有3天」会被读成剩余 3 箱。
 */
const RUNOUT_DAYS_WITH_VERB_RE =
  /(\d+|[一二两三四五六七八九十]+)\s*(天|日|周|星期)(?:左右|上下)?[^，。;；\s]{0,3}?(用完|用光|用尽|耗尽|没了|见底|快没)/;
const RUNOUT_DAYS_REMAINING_RE =
  /(?:还能用|还能够用|还能撑|还有|还剩|剩下)\s*(\d+|[一二两三四五六七八九十]+)\s*(天|日|周|星期)/;
/** 时间单位 → 天数 */
const DAY_UNIT_FACTOR: Record<string, number> = {
  天: 1, 日: 1, 周: 7, 星期: 7
};

const STATUS_KEYWORDS = [
  '还剩', '还有', '剩下', '用完', '用光', '用尽', '没了', '不多',
  '见底', '快没', '该补', '需要补', '要补', '空了', '最后一', '预计', '还能用'
];

function aliasGroupOf(name: string): number {
  return NAME_ALIAS_GROUPS.findIndex((group) => group.some((alias) => name.includes(alias)));
}

/** 存储名与口语名是否指同一物品 */
function nameMatches(storedName: string, spokenName: string): boolean {
  if (!storedName || !spokenName) return false;
  if (storedName === spokenName) return true;
  if (storedName.includes(spokenName) || spokenName.includes(storedName)) return true;
  const group = aliasGroupOf(spokenName);
  if (group < 0) return false;
  return NAME_ALIAS_GROUPS[group].some((alias) => storedName.includes(alias));
}

/** 从消息中找出被提到的消耗品（按存储条目匹配，支持一次提多个） */
export function looksLikeConsumableStatusUpdate(
  message: string,
  consumableNames: string[] = []
): boolean {
  const text = message.trim();
  if (!text) return false;
  if (QUESTION_RE.test(text)) return false;

  const hasStatusKeyword = STATUS_KEYWORDS.some((k) => text.includes(k));
  if (!hasStatusKeyword) return false;

  // 名称必须命中「已登记的消耗品」或内置消耗品词表，避免「番茄还剩两个」误入
  const hasConsumableName =
    consumableNames.some((n) => nameMatches(text, n)) ||
    CONSUMABLE_NAMES.some((n) => text.includes(n));
  if (!hasConsumableName) return false;

  return /\d|[一二两三四五六七八九十]/.test(text) || USED_UP_RE.test(text) || RUNNING_LOW_RE.test(text);
}

export function runUpdateConsumableStatusTask(
  context: AITaskContext
): AITaskExtraction {
  const consumables = (context.consumables ?? []).filter((c) => c.status !== 'finished');
  const phrases = splitPhrases(context.message);

  const updates: ConsumableStatusUpdate[] = [];
  const unmatched: string[] = [];

  for (const phrase of phrases) {
    if (!STATUS_KEYWORDS.some((k) => phrase.includes(k))) continue;

    const matched = consumables.filter((item) => nameMatches(phrase, item.name));
    if (matched.length === 0) {
      const spoken = CONSUMABLE_NAMES.find((n) => phrase.includes(n));
      if (spoken) unmatched.push(spoken);
      continue;
    }

    for (const item of matched) {
      if (updates.some((u) => u.consumableId === item.id)) continue;
      // 单位随更新结果一起带走：由它派生的采购草稿要沿用，不然「1」会失去意义
      updates.push({
        ...buildStatusUpdate(item, phrase),
        ...(item.unit ? { unit: item.unit } : {})
      });
    }
  }

  const urgent = updates.filter((u) => u.urgency === 'urgent');
  const soon = updates.filter((u) => u.urgency === 'soon');

  /*
   * 补货不另造卡片：紧急项直接派生成标准采购草稿挂在同一条消息上。
   * 于是「预算 20 块，明天买」这类一句话由 add_shopping_item 会话照常绑定，
   * 用户看到的也还是那张熟悉的 ShoppingDraftConfirm。
   */
  const restockDrafts: ShoppingItemDraft[] = urgent.map((u) => ({
    name: u.name,
    ...(u.unit ? { unit: u.unit } : {}),
    notes: '消耗品告急，AI 建议补货'
  }));

  let replyText: string;
  if (updates.length === 0) {
    replyText =
      unmatched.length > 0
        ? `我还没把「${unmatched.join('、')}」记进消耗品列表，所以没法更新它的余量。要现在添加它吗？`
        : '能告诉我是哪个消耗品、还剩多少吗？例如：面巾纸还剩两包。';
  } else {
    const lines = updates.map((u) => `• ${u.name}：${u.summary}`);
    replyText = `已更新消耗品情况：\n${lines.join('\n')}`;
    if (urgent.length > 0) {
      const finished = urgent.filter((u) => u.markFinished).map((u) => u.name);
      const runningOut = urgent.filter((u) => !u.markFinished).map((u) => u.name);
      const situation: string[] = [];
      if (finished.length > 0) situation.push(`${finished.join('、')}已经用完了`);
      if (runningOut.length > 0) situation.push(`${runningOut.join('、')}快见底了`);
      replyText += `\n\n${situation.join('，')}。我先放进采购草稿，你大概什么时候买、预算多少？不想补就点取消。`;
    } else if (soon.length > 0) {
      replyText += `\n\n${soon.map((u) => u.name).join('、')}快用完了，建议提前补货。`;
    }
  }

  return {
    intent: {
      taskType: 'update_consumable_status',
      confidence: updates.length > 0 ? 0.9 : 0.4,
      reason:
        updates.length > 0
          ? `识别到 ${updates.length} 条消耗品余量更新`
          : '命中消耗品余量语义但未匹配到已登记条目'
    },
    drafts: { updates },
    shoppingDrafts: restockDrafts.length > 0 ? restockDrafts : undefined,
    replyText,
    requiresConfirmation: false,
    consumableUpdates: updates
  };
}

/** 解析「还有 3 天用完」类表述 → 天数；不是天数返回 null */
function parseRunOutDays(phrase: string): number | null {
  const withVerb = phrase.match(RUNOUT_DAYS_WITH_VERB_RE);
  const raw = withVerb
    ? { value: withVerb[1], unit: withVerb[2] }
    : (() => {
        const m = phrase.match(RUNOUT_DAYS_REMAINING_RE);
        return m ? { value: m[1], unit: m[2] } : null;
      })();
  if (!raw) return null;
  const value = parseChineseNumber(raw.value);
  const factor = DAY_UNIT_FACTOR[raw.unit];
  if (value == null || !factor) return null;
  return value * factor;
}

function buildStatusUpdate(item: ConsumableItem, phrase: string): ConsumableStatusUpdate {
  const runOutDays = parseRunOutDays(phrase);
  if (runOutDays !== null) {
    // 余量天数按采购提前量分级：已到补货窗口 = urgent，两周内 = soon。
    return {
      consumableId: item.id,
      name: item.name,
      estimatedRunOutDays: runOutDays,
      urgency:
        runOutDays <= PURCHASE_LEAD_DAYS
          ? 'urgent'
          : runOutDays <= 14
            ? 'soon'
            : 'normal',
      markFinished: false,
      summary: `预计 ${runOutDays} 天后用完`
    };
  }

  const remainingMatch = phrase.match(REMAINING_RE);
  const isRunningLow = RUNNING_LOW_RE.test(phrase);
  const isUsedUp = USED_UP_RE.test(phrase);

  if (remainingMatch) {
    const remainingQuantity = parseChineseNumber(remainingMatch[1]) ?? 0;
    const unit = remainingMatch[2] ?? item.unit ?? '';
    if (remainingQuantity <= 0) {
      return {
        consumableId: item.id,
        name: item.name,
        remainingQuantity: 0,
        urgency: 'urgent',
        markFinished: true,
        summary: '已用完'
      };
    }
    return {
      consumableId: item.id,
      name: item.name,
      remainingQuantity,
      urgency: remainingQuantity <= 1 ? 'soon' : 'normal',
      markFinished: false,
      summary: `剩余 ${remainingQuantity}${unit}`.trim()
    };
  }

  if (isUsedUp && !isRunningLow) {
    return {
      consumableId: item.id,
      name: item.name,
      remainingQuantity: 0,
      urgency: 'urgent',
      markFinished: true,
      summary: '已用完'
    };
  }

  return {
    consumableId: item.id,
    name: item.name,
    urgency: 'soon',
    markFinished: false,
    summary: '快用完了'
  };
}


export function looksLikeAddConsumable(message: string): boolean {
  // 双保险：「面巾纸不用买了」里的「买了」是「不用买 + 语气词了」的子串巧合，
  // 会被下面的 BOUGHT_KEYWORDS.includes 命中。路由层的守卫已经先拦一道，这里再兜一次
  // —— 这个函数还有别的调用方，不能假设调用方记得先判否定。
  if (isNegatedPurchase(message) || readPurchaseCancellation(message)) return false;

  const lower = message.toLowerCase();
  // 必须同时满足：有购买语义 + 有消耗品名（避免"买番茄"误入）
  const bought = BOUGHT_KEYWORDS.some((k) => lower.includes(k));
  const hasConsumableName = CONSUMABLE_NAMES.some((n) => lower.includes(n));
  return bought && hasConsumableName;
}

export function extractInitialConsumableDrafts(message: string): ConsumableDraft[] {
  const drafts: ConsumableDraft[] = [];
  const phrases = splitPhrases(message);
  for (const phrase of phrases) {
    const item = tryParse(phrase);
    if (item && item.name && isConsumableName(item.name)) {
      drafts.push({
        name: item.name,
        quantity: item.quantity,
        unit: item.unit,
        status: 'collecting',
        // 名称里已经带出位置的（「面巾纸放在储物室」）不必再追问 location
        ...(item.location ? { location: item.location } : {}),
        missingFields: item.location
          ? ['run_out_estimate']
          : ['location', 'run_out_estimate']
      });
    }
  }
  if (drafts.length === 0) {
    const fallback = tryParse(message);
    if (fallback && fallback.name && isConsumableName(fallback.name)) {
      drafts.push({
        name: fallback.name,
        quantity: fallback.quantity,
        unit: fallback.unit,
        status: 'collecting',
        missingFields: ['location', 'run_out_estimate']
      });
    }
  }
  return drafts;
}

/**
 * 入口：add_consumable 任务。
 *
 * 首条消息可能已经带上「放在储物间 / 大概 20 天用完」，因此提取完草稿后
 * 立刻过一遍会话绑定，避免明知答案还追问；缺字段时才进入 collecting。
 *
 * 会话进行中又说「今天买了洗衣液」时并入现有草稿：已答完位置/节奏的条目
 * 不应被一次新增而清零重来。
 */
export function runAddConsumableTask(context: AITaskContext): AITaskExtraction {
  const initial = extractInitialConsumableDrafts(context.message);
  const existing =
    context.activeTask?.taskType === 'add_consumable'
      ? (context.activeTask.consumableDrafts ?? [])
      : [];
  const base =
    initial.length > 0 ? mergeConsumableDrafts(existing, initial) : existing;
  const session =
    base.length > 0 ? applyConsumableSessionReply(base, context.message) : null;
  const drafts = session ? session.drafts : [];

  const replyText = session
    ? session.replyText
    : '可以告诉我你今天买了哪些消耗品吗？例如：面巾纸、洗衣液、生抽。';

  return {
    intent: {
      taskType: 'add_consumable',
      confidence: drafts.length > 0 ? 0.9 : 0.5,
      reason:
        drafts.length > 0
          ? `识别到 ${drafts.length} 个消耗品`
          : '命中消耗品购买语义但未识别具体物品'
    },
    drafts: { items: drafts },
    replyText,
    requiresConfirmation: true,
    consumablePhase: session ? session.phase : 'collecting'
  };
}

export { CONSUMABLE_NAMES, BOUGHT_KEYWORDS };