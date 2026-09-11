/**
 * add_shopping_item Task
 *
 * 输入：用户自然语言描述的采购需求。
 *
 * 输出：
 * - items: ShoppingItemDraft[]（仅提取 name 必填，其它推荐字段尽力提取）
 * - replyText: 自然的确认提示文本（不强制要求字段全部提供）
 *
 * 实现策略：
 * - 第一阶段使用确定性关键词扫描与轻量正则提取，避免额外 AI 调用。
 *   这与"AI 不必完整提取所有字段"的原则一致：
 *   - name 必须识别
 *   - quantity / unit / neededBy 尽力提取
 *   - 其它字段留空，由 confirmation UI 让用户补
 *
 *   后续阶段可在此基础上叠加 LLM 提取，但 router 不依赖 LLM 也能工作。
 *
 * 设计上不调用 localStorage；落地由 /shopping-list 页面与确认组件处理。
 */

import type {
  AITaskContext,
  AITaskExtraction,
  RestockItemDraft,
  ShoppingItemDraft
} from './types';
import type { ShoppingList } from '@/lib/types/shopping-list';
import type { RecipeIngredient } from '@/lib/types/recipe';
import { isNegatedPurchase, readPurchaseCancellation } from './action-guard';

const NEEDED_TODAY_KEYWORDS = ['今天', '今晚', '今天晚上', '今天下午'];
const NEEDED_TOMORROW_KEYWORDS = ['明天', '明早', '明天上午', '明天下午', '明天晚上'];
const NEEDED_DAY_AFTER_TOMORROW_KEYWORDS = ['后天', '大后天'];
/** 不含裸「周末」：下周末 / 这周末靠这里的词命中，语义与改动前一致 */
const NEEDED_THIS_WEEK_KEYWORDS = ['这周', '本周', '下周'];
/** 单独一档，且必须排在上一条之后，否则「下周末」会被短词抢先改写成「周末」 */
const NEEDED_WEEKEND_KEYWORDS = ['周末'];

/**
 * 把"今天 / 明天 / 后天 / 周末"等相对时间转写为 neededBy 自由文本。
 *
 * 判定顺序即优先级：neededBy 是给人看的自由文本，「后天」塌缩成「明天」、
 * 「周末」塌缩成「本周」都会让用户以为时间被理解错了，所以能精确表达就精确表达。
 */
function normalizeNeededBy(text: string): string | undefined {
  if (NEEDED_TODAY_KEYWORDS.some((k) => text.includes(k))) return '今天';
  if (NEEDED_TOMORROW_KEYWORDS.some((k) => text.includes(k))) return '明天';
  if (NEEDED_DAY_AFTER_TOMORROW_KEYWORDS.some((k) => text.includes(k)))
    return text.includes('大后天') ? '大后天' : '后天';
  if (NEEDED_THIS_WEEK_KEYWORDS.some((k) => text.includes(k))) return '本周';
  if (NEEDED_WEEKEND_KEYWORDS.some((k) => text.includes(k))) return '周末';
  return undefined;
}

/**
 * 中文数字解析：返回 number；解析失败返回 undefined。
 * 支持："1" "两" "三" "几" "一个" "两包"。
 */
function parseChineseNumber(token: string): number | undefined {
  const map: Record<string, number> = {
    一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5,
    六: 6, 七: 7, 八: 8, 九: 9, 十: 10
  };
  if (!token) return undefined;
  // 阿拉伯数字优先
  const arabicMatch = token.match(/(\d+(?:\.\d+)?)/);
  if (arabicMatch) return Number(arabicMatch[1]);
  for (const [k, v] of Object.entries(map)) {
    if (token.includes(k)) return v;
  }
  return undefined;
}

/**
 * 极简中文句子切分。
 *
 * 现状 Qingshe 偏向"列出几个物品"的输入（"买面巾纸和洗衣液"）。
 * 通过 、 / 和 / 以及空格做粗切分。
 */
function splitSentences(message: string): string[] {
  return message
    .split(/[、，；\n]|(?:和|以及|还有)/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

const KNOWN_UNITS = ['包', '瓶', '盒', '袋', '个', '件', '箱', '罐', '桶', 'kg', 'g', '升', '毫升', 'L', 'ml'];

/**
 * 采购意图前缀剥离（与 consumable-task 的分段归一化同一思路，但词表不同：
 * 这里只处理「尚未购买」的采购表达，不能吞掉「买了」这类已购语义）。
 *
 * 主语 / 情态 / 动词可叠加（「明天帮我想要买...」），因此循环剥离直到稳定。
 */
const SUBJECT_PREFIX_RE = /^(?:我们|咱们|我|你|他|她|大家)?\s*/;
// 言语行为包装（告诉 / 提醒 / 通知）与「帮我 / 麻烦」同类：只出现在句首指代说话动作，
// 不会是货架上任何商品名的一部分。与 ITEM_NAME_REJECT_RE 保持同一封闭类词表。
// 「一下」是这类动词的补语（提醒我一下 / 告诉我一下），跟在代词后面单独剥。
// 时间词按长词优先排列，否则「大后天」会被短词表整体跳过、留在名字里。
const MODAL_PREFIX_RE =
  /^(?:新增|添加|加上|再加|还要|还要买|那|再|先|还|顺便|另外|记得|帮我|给我|替我|请|麻烦|告诉|提醒|通知|把|将|想|要|需要|准备|打算|现在|待会|今天|明天|大后天|后天|周末|晚上|早上)?\s*(?:我们|我|你)?\s*(?:一下)?\s*(?:想|要|打算|准备|需要|记得|顺便)?\s*/;
const VERB_PREFIX_RE =
  /^(?:买|下单|采购|囤|入手|购入|加购|补货|补充|添加|加入|加到|列入|放进|放到|记在|记入|带|加|补)(?:了|过|回来|到|进)?\s*/;
const LIST_NOUN_PREFIX_RE =
  /^(?:采购清单|购物清单|待买清单|购物单|采购单|清单)(?:里|中|内|上)?[：:，,]?\s*/;
const LIST_NOUN_SUFFIX_RE =
  /[，,、]?\s*(?:再|帮我|给我|加|加入|添加到|加到|列入|放进|放到|记在|记入)?\s*(?:采购清单|购物清单|待买清单|购物单|采购单|清单)(?:里|中|内|上)?\s*$/;
const TRAILING_PARTICLE_RE = /[吧呢啊呀哦了哈，,。.!！?？；;]+$/;
/** detectUnit 之后仍残留的裸数量词（「几包」「两袋」等） */
const STRAY_QUANTITY_RE =
  /^(?:[一二两三四五六七八九十\d]+|[几若干数])(?:包|瓶|盒|袋|个|件|箱|罐|桶|份|提|卷|支|块|千克|公斤|升|毫升|kg|g|l|ml)?的?\s*/i;

function normalizeShoppingSegment(raw: string): string {
  let segment = raw.trim();
  if (!segment) return '';

  for (let pass = 0; pass < 4; pass += 1) {
    const before = segment;
    segment = segment
      .replace(SUBJECT_PREFIX_RE, '')
      .replace(MODAL_PREFIX_RE, '')
      .replace(VERB_PREFIX_RE, '')
      .replace(LIST_NOUN_PREFIX_RE, '')
      .trim();
    if (segment === before) break;
  }

  return segment.replace(LIST_NOUN_SUFFIX_RE, '').replace(TRAILING_PARTICLE_RE, '').trim();
}

function detectUnit(text: string): { quantity?: number; unit?: string; rest: string } {
  // 模式: <num><unit><name>
  // 例: "1包面巾纸"、"两瓶洗衣液"
  const re = new RegExp(`(\\d+|[一二两三四五六七八九十])(?:\\s*)(包|瓶|盒|袋|个|件|箱|罐|桶|千克|公斤|升|毫升|kg|g|l|ml)(?:的)?`, 'i');
  const m = text.match(re);
  if (m) {
    const q = parseChineseNumber(m[1]);
    const unit = m[2].toLowerCase();
    const rest = text.replace(m[0], '').trim();
    return {
      quantity: q,
      unit,
      rest
    };
  }
  // 口语省略数量：「买包纸巾」「来盒牛奶」→ 视为 1 包 / 1 盒。
  // 要求剩余至少 2 字，避免把「盒子」「袋子」这类词拆坏。
  const bare = text.match(
    /^(包|瓶|盒|袋|个|件|箱|罐|桶)(?:的)?([\u4e00-\u9fa5a-zA-Z]{2,})$/
  );
  if (bare) {
    return { quantity: 1, unit: bare[1], rest: bare[2].trim() };
  }
  return { rest: text };
}

/** 疑问 / 泛指短语不是物品名 */
const INTERROGATIVE_RE =
  /^(?:什么|啥|哪|多少|谁|怎么|怎样|如何|为什么|干嘛|干吗|要不要|能不能|可不可以|是否|不知道|不想|不用|不需要|点|些)/;

/**
 * 一个可信的商品名里，不可能还残留这些成分。
 *
 * 商品名是开放类，没法枚举；但时间词、金额词、人称代词、言语动词是封闭类，
 * 可以可靠地排除。前缀剥离只能覆盖词表里写过的包装语（「帮我」「顺便」），
 * 漏掉一个（「告诉我」「那就」），整句话就会被当成商品名。反过来判定
 * 「名字里是否还留着封闭类成分」是一次写对、对所有口语包装都生效的判据。
 */
const ITEM_NAME_REJECT_RE = new RegExp(
  [
    // 时间词：采购时间是字段，不会长在货架上的东西名字里
    '今天|明天|后天|大后天|前天|昨晚|今晚|明早|明晚|上午|下午|晚上|早上|中午|凌晨|半夜',
    '(?:这|那|本|下|上)\\s*(?:个|几)?\\s*(?:周|星期|礼拜|月|年|号|日)',
    // 金额词：预算是字段
    '预算|控制在|不超过|最多|起步|以内|左右|以下|以上|人民币|[0-9０-９]+\\s*[元块]',
    // 说话的人在指代自己或提出请求，不是在报商品
    '[我你您咱]|告诉|通知|提醒|麻烦|觉得|以为|记得|想起|看看|看下|一下|顺便|另外|其实|反正'
  ].join('|')
);

/**
 * 名字是否可信：剥完前缀后剩下的核心里不该还有任何封闭类成分。
 * 正常条目（'纸巾' / '面巾纸' / '洗衣液'）在 detectUnit 之后天然通过。
 */
export function isCredibleItemName(name: string): boolean {
  return name.trim().length > 0 && !ITEM_NAME_REJECT_RE.test(name);
}
/** 过度泛化的占位名（「东西」「这个」） */
const GENERIC_NAME_RE =
  /^(?:东西|物品|一些|一点|这个|那个|这些|那些|它|他|她|别的|其他)$/;
const MAX_NAME_LEN = 20;

/**
 * 尝试从一个短语中提取一个 ShoppingItemDraft。
 * 解析失败返回 null，调用方应直接放弃该短语。
 */
/** 「预算20块 / 不超过30元 / 预算 ¥25」→ 金额。必须有明确预算词，避免把数量当预算。 */
const BUDGET_RE = /(?:预算|不超过|最多|控制在)\s*(?:¥|￥)?\s*([一二两三四五六七八九十\d]+)\s*(?:元|块钱|块|毛)?/;

function parseBudget(text: string): number | undefined {
  const m = text.match(BUDGET_RE);
  if (!m) return undefined;
  const value = parseChineseNumber(m[1]);
  return value != null && value > 0 ? value : undefined;
}

/* ------------------------------------------------------------------ *
 * Field-only message
 *
 * 采购会话里，用户常用一句话补字段而不报物品名：
 *   「预算20元，明天买」「后天买」「20块，明天」
 * 这类句子没有任何商品，只有预算 + 时间 + 连接词。它们该由
 * applyShoppingFieldReply 绑到已有草稿上，绝不能被当成一条新商品。
 *
 * 判定方式是「剥离后看是否还剩东西」，而不是枚举整句：
 * 只要剥掉预算、时间、字段动词、标点后什么都不剩，就是纯字段回答。
 * 任何残留（哪怕只有「纸巾」两个字）都判为 false，宁可漏判不误判。
 * ------------------------------------------------------------------ */

/** 预算表达的全局版本：与 BUDGET_RE 共用词表，避免两处规则漂移 */
const BUDGET_STRIP_RE = new RegExp(BUDGET_RE.source, 'g');

/** 相对 / 绝对时间说法，长词在前保证「大后天」不被「后天」吃掉一半 */
const TIME_EXPRESSION_RE =
  /(?:大后天|后天|明天上午|明天下午|明天晚上|今天晚上|今天下午|今晚|明早|明天|今天|这周|本周|下周|下周末|周末|星期[一二三四五六日天]|周[一二三四五六日天]|上午|下午|晚上|早上|中午|待会儿|待会|一会儿)/g;

/** 裸金额：「20元预算」「¥25」——没有物品名时它只能是预算，不是商品 */
const BARE_AMOUNT_RE =
  /(?:[¥￥]\s*[一二两三四五六七八九十\d]+(?:\.\d+)?|[一二两三四五六七八九十\d]+(?:\.\d+)?\s*(?:元|块钱|块|毛|钱))/g;

/** 只服务于「补哪个字段」的动词与连接词，本身不指代任何物品 */
const FIELD_FILLER_RE =
  /(?:预算|控制在|不超过|最多|购买|下单|入手|购入|加购|补货|补充|计划|打算|准备|大概|大约|帮我|给我|替我|麻烦|还有|以及|另外|顺便|记得|需要|想|要|买|带|请|再|和|与|就|的|了|吧|呢|啊|呀|哦|哈|嗯)/g;

export function isShoppingFieldOnlyMessage(message: string): boolean {
  const residue = message
    .replace(BUDGET_STRIP_RE, '')
    .replace(TIME_EXPRESSION_RE, '')
    .replace(BARE_AMOUNT_RE, '')
    .replace(FIELD_FILLER_RE, '')
    .replace(/[\s、，,.。！!？?；;：:~～]+/g, '');
  return residue.length === 0;
}

function tryParseItem(phrase: string, fullText: string): ShoppingItemDraft | null {
  const trimmed = phrase.trim();
  if (!trimmed) return null;

  // 否定采购不是商品：「不想买纸巾」剥掉前缀后只剩「纸巾」，看起来像一条
  // 正向采购 —— 恰恰是用户说不想要的东西。整句带否定词的，直接不出草稿。
  if (isNegatedPurchase(trimmed)) return null;

  // 剥离「我想买 / 帮我买 / 加入采购清单」等采购意图前缀与清单后缀，
  // 只留下「数量 + 单位 + 名称」核心片段。
  const cleaned = normalizeShoppingSegment(trimmed);

  if (!cleaned) return null;
  // 纯预算回答不是物品名：「预算20块」不该变成一条叫「预算20块」的商品
  if (BUDGET_RE.test(cleaned) && cleaned.replace(BUDGET_RE, '').trim() === '') {
    return null;
  }

  const { quantity, unit, rest } = detectUnit(cleaned);
  const name = rest
    .replace(/(?:放到|放进|送到|送过来)/g, '')
    .replace(STRAY_QUANTITY_RE, '')
    .replace(TRAILING_PARTICLE_RE, '')
    .trim();

  if (!name) return null;
  // 疑问句 / 泛指代词不是物品名：「什么牌子好」「要不要」「买点东西」
  if (INTERROGATIVE_RE.test(name)) return null;
  if (GENERIC_NAME_RE.test(name)) return null;
  if (name.length > MAX_NAME_LEN) return null;
  // 名字里还留着时间 / 金额 / 人称 / 言语动词 → 这是一句没剥干净的话，不是商品。
  // 「告诉我明天买，预算20」正是靠这条被丢弃，否则整句会变成一条幽灵商品。
  if (!isCredibleItemName(name)) return null;

  return {
    name,
    quantity,
    unit,
    neededBy: normalizeNeededBy(fullText),
    budget: parseBudget(fullText)
  };
}

/**
 * 从用户消息中提取 add_shopping_item 草稿。
 *
 * 不使用 AI 模型，使用确定性文本解析，确保：
 * - "我今天想买一包面巾纸和1瓶洗衣液，帮我加到采购清单" → 2 条草稿
 * - "帮我买纸巾" → 1 条草稿（无 quantity/unit）
 * - "明天帮我买两包纸巾" → 1 条草稿（含 neededBy）
 */
export function extractShoppingItems(message: string): ShoppingItemDraft[] {
  const drafts: ShoppingItemDraft[] = [];

  // 纯字段回答（「预算20元，明天买」）不含任何物品，应由 continuation 层
  // 绑到已有草稿上。走到下面的兜底会把整句当成商品名，凭空多出一条幽灵商品。
  if (isShoppingFieldOnlyMessage(message)) return drafts;

  // 整句在放弃采购时一个商品都不该产出。这是 parser 层的最后一道闸：
  // 上游守卫（router step 0.5 / continueShoppingTask）已经 hard stop，但本函数
  // 还被 runAddShoppingItemTask 等直接调用 —— 「算了，不买牙膏了」一旦流到这里，
  // splitSentences 会分裂出「算」「不买牙膏」两条幽灵商品。
  if (readPurchaseCancellation(message)) return drafts;

  const phrases = splitSentences(message);
  if (phrases.length === 0) return drafts;

  for (const phrase of phrases) {
    const item = tryParseItem(phrase, message);
    if (item && item.name) {
      drafts.push(item);
    }
  }

  // 兜底：如果没有 split 命中但整段看起来就是物品名（如"买纸巾"），整体尝试一次。
  if (drafts.length === 0) {
    const fallback = tryParseItem(message, message);
    if (fallback && fallback.name) {
      drafts.push(fallback);
    }
  }

  return drafts;
}

/**
 * 入口：执行 add_shopping_item task。
 *
 * 关键不变量：
 * - requiresConfirmation = true（AI 不直接写 Reality Data）。
 * - replyText 不会"因为字段不全就连续追问预算等可选字段"。
 *   只有在完全没有 name 时才给出"我没听清你想买什么"。
 */
export function runAddShoppingItemTask(
  context: AITaskContext
): AITaskExtraction {
  const items = extractShoppingItems(context.message);

  const replyText = buildShoppingDraftSummary(items);

  return {
    intent: {
      taskType: 'add_shopping_item',
      confidence: items.length > 0 ? 0.9 : 0.5,
      reason:
        items.length > 0
          ? `从消息中识别到 ${items.length} 件采购物品`
          : '命中采购语义但未识别出具体物品名'
    },
    drafts: { items },
    replyText,
    requiresConfirmation: true
  };
}

/**
 * 采购 Task 的回复文案。
 *
 * 刻意不复述物品 / 数量 / 时间 / 预算 —— 那些数据的唯一事实来源是
 * ShoppingDraftConfirm 渲染的 shoppingDrafts。文案一旦抄一份，用户改完
 * 草稿就会出现「上面还是旧文案、下面卡片已经改了」的双源不一致。
 *
 * 因此这里只说「去做什么」，具体「是什么」全部交给结构化卡片渲染。
 */
export function buildShoppingDraftSummary(items: ShoppingItemDraft[]): string {
  if (items.length === 0) {
    return '可以告诉我你想买什么吗？';
  }
  return '我已经帮你整理好了采购信息，请核对下面的卡片。需要改动直接点「修改」，也可以直接告诉我要补什么。';
}

/**
 * 给 router 用的轻量判定：当前消息是否可能属于 add_shopping_item。
 *
 * 只覆盖「尚未购买」的采购意图；「买了 / 刚买了」这类已购语义由
 * looksLikeAddConsumable / add_inventory 处理，因此这里显式排除完成态。
 *
 * 与 runAddShoppingItemTask 解耦：router 只做"是不是这个 task"，不做提取。
 */
/**
 * 把新一批解析结果并入进行中的采购草稿。
 *
 * 同名条目：只覆盖这次真正解析出来的字段，留空的字段保留用户已填的值
 * （否则「明天买」会把已经填好的预算清掉）。
 */
export function mergeShoppingDrafts(
  existing: ShoppingItemDraft[],
  incoming: ShoppingItemDraft[]
): ShoppingItemDraft[] {
  const merged = existing.map((item) => ({ ...item }));
  for (const item of incoming) {
    const hit = merged.find((d) => d.name === item.name);
    if (!hit) {
      merged.push({ ...item });
      continue;
    }
    if (item.quantity != null) hit.quantity = item.quantity;
    if (item.unit) hit.unit = item.unit;
    if (item.neededBy) hit.neededBy = item.neededBy;
    if (item.budget != null) hit.budget = item.budget;
    if (item.notes) hit.notes = item.notes;
  }
  return merged;
}

/**
 * 把「预算20块」「明天买」这类不含物品名的回答绑定到现有草稿上。
 *
 * 这些句子过 extractShoppingItems 只会得到空结果，用户的补充信息就被丢了。
 * 采购草稿是唯一数据源：summary 文本、确认卡片、storage 写入必须读同一份字段。
 */
export function applyShoppingFieldReply(
  drafts: ShoppingItemDraft[],
  message: string
): ShoppingItemDraft[] {
  if (drafts.length === 0) return drafts;
  const budget = parseBudget(message);
  const neededBy = normalizeNeededBy(message);
  if (budget == null && !neededBy) return drafts;
  return drafts.map((d) => ({
    ...d,
    ...(budget != null && d.budget == null ? { budget } : {}),
    ...(neededBy && !d.neededBy ? { neededBy } : {})
  }));
}

export function looksLikeAddShoppingItem(message: string): boolean {
  const text = message.trim();
  if (!text) return false;

  // 已购语义优先排除（「今天买了1箱面巾纸」不是采购清单）
  if (/(?:买了|买过|买回|刚买|新买|入手了|购入了|囤了|补了货|已经买|买好了)/.test(text))
    return false;

  // 明确采购动词
  if (/(?:想买|要买|要购买|购买|买|下单|订购|采购|加购|囤|入手|购入|补货|补充|带上|带)/.test(text))
    return true;

  // 「加入 / 加到 / 列入 / 记在 + 清单」这类无动词也要接住
  if (/(?:加入|加到|加进|列入|记在|记入|记到|放进|放到)[^，,。]{0,6}清单/.test(text))
    return true;

  // 直接点名清单（「采购清单里还有啥」）
  if (/(?:采购清单|购物清单|待买清单|购物单|采购单)/.test(text)) return true;

  return false;
}

/**
 * 菜谱缺料 → 采购草稿。
 *
 * 结构化字段唯一来源是 Recipe.ingredients（RecipeIngredient[]）：
 * - quantity 库里是复合串（'2个' / '500ml' / '适量'），只取前导数字，
 *   取不到（'适量' / '少许'）就留空，绝不把备注串塞进数量字段。
 * - unit 原样带上，空串视为未知。
 * - 只转换出现在 missingNames 里的食材。缺料名集本身由 Recipe Match 从
 *   required 食材生成（optional 永远不会出现在里面），因此这里按名匹配
 *   required 与 optional 皆可 —— 把 optional 名误当「结构化表未覆盖」而
 *   降级补一条，等于给不需要的东西造采购草稿。
 * - missingNames 有、但结构化表里找不到对应项时（例如 fullRecipe 尚未加载），
 *   降级为只带 name 的草稿 —— name 本身也是纯食材名（Recipe Match 保证），
 *   不是渲染用的「番茄（2个）」展示串。
 *
 * 纯函数，零副作用：不读 storage、不写 storage。写盘仍然只有
 * ShoppingDraftConfirm → commitShoppingDrafts 这一条路。
 */
export function recipeIngredientsToShoppingDrafts(
  ingredients: readonly RecipeIngredient[],
  missingNames: readonly string[],
  recipeId?: string
): ShoppingItemDraft[] {
  const missing = missingNames.map((name) => name.trim()).filter(Boolean);
  if (missing.length === 0) return [];

  const missingSet = new Set(missing);
  const covered = new Set<string>();
  const drafts: ShoppingItemDraft[] = [];

  for (const ing of ingredients) {
    const name = ing.name.trim();
    if (!missingSet.has(name) || covered.has(name)) continue;
    covered.add(name);
    const quantity = /^\s*(\d+(?:\.\d+)?)\s*/.exec(ing.quantity ?? '');
    const unit = ing.unit?.trim();
    drafts.push({
      name,
      ...(quantity ? { quantity: Number(quantity[1]) } : {}),
      ...(unit ? { unit } : {}),
      ...(recipeId ? { recipeId } : {})
    });
  }

  for (const name of missing) {
    if (covered.has(name)) continue;
    covered.add(name);
    drafts.push({ name, ...(recipeId ? { recipeId } : {}) });
  }

  return drafts;
}

// ============================================================
// 采购完成（complete_purchase）：清单里的东西到手 → 入厨房
// ============================================================

/**
 * 采购完成的说法：东西确实已经到手。
 *
 * 只认带结果补语的形态。「买了」不算 —— 那是在告诉系统一件事，不是在收货；
 * 「我去买好菜」「买好吃的」也不算，它们缺的正是那个「了」。
 */
const PURCHASE_COMPLETE_PHRASES = [
  '买回来了', '买回来', '买好了', '买到手了', '买到手', '买完了', '买齐了',
  '采购回来了', '采购好了', '囤回来了', '囤好了', '入手回来了'
] as const;

/**
 * 这句话点名了清单上的哪些东西。
 *
 * 只认还挂在清单上、且没入过库的条目。清单对不上就不算采购完成，
 * 退回原有路由 —— 宁可少抢一次，也不凭空造一张入库卡。
 *
 * 状态判据是「不等于 cancelled」而不是「等于 pending」：真人的顺序是先到采购清单页
 * 把条目勾成 purchased，再开口说「都买回来了」。只认 pending 会把这条最正常的路径
 * 退回消耗品录入，正是要修的 bug。cancelled 仍然排除 —— 用户明确不要的东西
 * 不该被一句话拽回厨房。
 */
function readRestockTargets(message: string, lists: ShoppingList[] = []): RestockItemDraft[] {
  return lists.flatMap(list =>
    list.items
      .filter(item =>
        item.name &&
        item.status !== 'cancelled' &&
        !item.restockedAt &&
        message.includes(item.name)
      )
      .map(item => ({ ...item, listId: list.id }))
  );
}

/**
 * complete_purchase Task：采购完成 → 「加入厨房」确认。
 *
 * 它必须排在 add_consumable 前面：「我把盐和食用油都买回来了」里的盐和油
 * 确实是消耗品，但用户报的是「到手」，不是「请帮我建档」。
 * 这一步不问存放位置、也不问多久用完 —— 那些都不是采购完成的必要条件。
 * 产出的是待确认草稿，写进现实要等用户点确认。
 */
export function runPurchaseCompleteTask(context: AITaskContext): AITaskExtraction | null {
  const claimed =
    PURCHASE_COMPLETE_PHRASES.some((phrase) => context.message.includes(phrase)) &&
    !isNegatedPurchase(context.message);
  const items = claimed ? readRestockTargets(context.message, context.shoppingLists) : [];
  if (items.length === 0) return null;

  return {
    intent: {
      taskType: 'complete_purchase',
      confidence: 0.95,
      reason: `采购完成：清单里的 ${items.length} 样已到手 → 入厨房确认，不进入消耗品记录`
    },
    drafts: { items },
    replyText: `${items.map(item => item.name).join('、')} 买回来了，确认后放进厨房。`,
    requiresConfirmation: true
  };
}

export { KNOWN_UNITS, parseChineseNumber };