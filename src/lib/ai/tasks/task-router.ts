/**
 * AI Task Router
 *
 * 极简实现：不调用 LLM。
 * 根据用户输入 + 当前上下文（是否有 active draft / ingredients），路由到：
 *   - chat
 *   - add_inventory
 *   - add_shopping_item
 *   - add_reminder   （占位，未实现）
 *   - create_life_record （占位，未实现）
 *
 * 设计原则：
 * - 路由优先级：add_shopping_item > add_inventory > chat
 *   当文本明显是"购物/采购"语义时，优先 add_shopping_item 而不是 add_inventory。
 *   这是为了修复 "我想买一包面巾纸" 错误落入 add_inventory 的问题。
 * - 任何路由都附带 reason，便于日志/调试。
 * - 不调用 LLM，不调用 localStorage，纯函数 + 轻量文本判定。
 */

import type {
  ActiveTaskSnapshot,
  AITaskContext,
  AITaskExtraction,
  AITaskType,
  CardCommand,
  CardKind
} from './types';
import {
  runAddShoppingItemTask,
  looksLikeAddShoppingItem,
  runPurchaseCompleteTask
} from './shopping-task';
import {
  runAddConsumableTask,
  runUpdateConsumableStatusTask,
  looksLikeAddConsumable,
  looksLikeConsumableStatusUpdate
} from './consumable-task';
import {
  hasActiveConsumableSession,
  hasActiveShoppingSession,
  pendingCardOf
} from './active-task';
import { detectItemRemoval, readPurchaseCancellation } from './action-guard';
import { readCardCommand } from '@/lib/ai/confirmation';

const INVENTORY_KEYWORDS = [
  '买了',
  '我今天买了',
  '刚买',
  '新增',
  '收了一',
  '采购了',
  '入了',
  '入了冰箱',
  '放进冰箱',
  '放冰箱',
  '入了冷藏',
  '放入',
  '囤到冰箱',
  '冰箱多了'
];

/**
 * P0.5-1 现实录入句式（Router 与 record.ts 批量解析共用同一份判定，
 * 避免两处正则漂移：Router 判「进不进 REALITY_RECORD」，
 * parser 判「这句话里的哪一段是食材名单」）。
 */

/**
 * 疑问守卫：「冰箱里有什么？」「我有牛肉吗？」是在查询现实，
 * 不是告诉轻舍现实。带任一疑问标记的句子永远不进确定性录入，
 * 交给查询/解决方案通道。
 */
export const RECORD_QUESTION_GUARD_RE =
  /[？?]|吗|什么|哪些|哪样|多少|怎么办|怎样|怎么|如何|做什么|吃什么|喝什么|咋办|够不够|还有没有|有没有|是不是|能不能|可不可以|要不要|该|还是|拿不准|不确定|推荐|建议|(?:呢)(?=[。！\s]*$)/;

/**
 * 祈使录入：「加进/放进/收进/存进/放到/加入/添加到/录入/登记 + 冰箱」，
 * 以及「买回来放进冰箱」这类购买-放置组合。全部要求动词紧邻冰箱词，
 * 不会把「冰箱整理一下」判成录入。
 */
export const FRIDGE_RECORD_ENTRY_RE =
  /(?:加|放|收|存|投|塞|挪)进(?:到)?(?:我的|冷藏|保鲜|冷冻)?(?:冰箱|冰柜)(?:里|中|内)?|放(?:到|至)(?:我的|冷藏|保鲜)?(?:冰箱|冰柜)(?:里|中|内)|(?:加入|添加到|录入|登记)(?:到|入)?(?:我的|冷藏|保鲜|冷冻)?(?:冰箱|冰柜)|(?:买|囤|拿)(?:回来|回家)?[^，,。；;]{0,12}(?:冰箱|冰柜)/;

/**
 * 厨房区域词表（共享层唯一的词典）：用户说出口的位置词 → 真实储存位置语义。
 *
 * Router 用它认「橱柜里有食盐和食用油」这种陈述式录入，Parser 用它按区域分段 ——
 * 一份词表两处读，不再长出第二套。
 *
 * `location === undefined` 不是缺省，是**真值**：「厨房」只是顶层场所，
 * 不等于冷藏/冷冻/橱柜中的任何一处。Parser 只记录用户说出来的位置，
 * 没说过的一律留 undefined，绝不在这张表里替用户做主填成「冷藏」。
 */
export type KitchenStorageLocation = '冷藏' | '冷冻' | '橱柜' | '常温' | '其他';

export const KITCHEN_REGION_LEXICON: ReadonlyArray<{
  words: readonly string[];
  location: KitchenStorageLocation | undefined;
}> = [
  { words: ['冷藏室', '冷藏柜', '保鲜室', '保鲜层', '冰箱', '冰柜', '冷藏', '保鲜'], location: '冷藏' },
  { words: ['冷冻室', '冷冻柜', '急冻室', '冷冻'], location: '冷冻' },
  { words: ['橱柜', '储物柜', '碗柜', '柜子'], location: '橱柜' },
  { words: ['常温', '室温'], location: '常温' },
  { words: ['储物间', '杂物间', '置物架', '阳台', '抽屉'], location: '其他' },
  // 「厨房」是产品的顶层概念，不是任何一处储存位置：命中它只证明这句话在说厨房，
  // 位置仍然未知。undefined 是真值，下游不许拿「生鲜默认冷藏」把它填掉。
  { words: ['厨房'], location: undefined }
];

/** 区域词 → 储存位置；undefined = 用户没说储存位置（不是「没匹配上」） */
export function kitchenLocationOf(word: string): KitchenStorageLocation | undefined {
  return KITCHEN_REGION_LEXICON.find((entry) => entry.words.includes(word))?.location;
}

/** 交替式按词长倒序 —— 「冷藏柜」不能被「冷藏」咬断，「冷冻室」不能被「冷冻」咬断 */
export const KITCHEN_REGION_WORD_ALT = KITCHEN_REGION_LEXICON.flatMap((entry) => entry.words)
  .sort((a, b) => b.length - a.length)
  .join('|');

/**
 * 陈述录入：以「（我）（现在）（的）+ 厨房区域词 + （里面/里…）+ （时间副词）+ 有/放了/装着/多了…」开头。
 * 锚定句首是因为「冰箱里有牛肉」是事实陈述；句中出现「冰箱里有」多为
 * 查询或方案讨论的前置从句，交给守卫和其它通道处理。
 * 时间副词允许出现在区域词之后（「我冰箱里现在有牛肉」）：位置声明和「现在」
 * 谁前谁后都是同一句话，但整条式子仍然只认句首的这一种结构。
 *
 * 区域词来自上面那张词表：「我橱柜里有食盐和食用油」以前不配当录入入口
 * （门只认冰箱），整句被扔给 LLM 猜意图 —— 真人测试第一次判成 LIFE_SOLUTION
 * 就是这么来的。门和解析器必须读同一张表，否则 Parser 认得出的句子永远走不到它面前。
 */
export const FRIDGE_CLAIM_RE = new RegExp(
  '^(?:(?:我们|我|家里|咱们|咱|您|你)(?:现在|目前|还|都|已经|又|新)?(?:的)?)?(?:' +
    KITCHEN_REGION_WORD_ALT +
    ')(?:里面|里|中|内|室|下)?(?:现在|目前|还|都|已经|又|新)?(?:有|放了|放着|装着|装了|多了|新添了|添了|摆着)'
);

/**
 * 购买前缀：「（时间）（主语）（刚/新）买了…」。时间与主语都可选、允许两种语序
 * （「今天我买了」「我今天买了」「买了」），这是批量解析逐分句剥离的入场券。
 */
export const INVENTORY_RECORD_PREFIX_RE =
  /^(?:(?:今天|昨天|前天|刚刚|刚才|今早|早上|上午|中午|下午|晚上)(?:我们|我|家里)?|(?:我们|我|家里)(?:今天|昨天|前天|刚刚|刚才)?)?(?:刚|新)?(?:买了|买回来了|买回来|买回了|购买了|购入了|采购了|囤了|囤|入手了|入了|新增了|新增|添了|添)\s*/;

/** 独立动作分句：「帮我加进冰箱」「放进冰箱」——只提供录入意图，不含食材 */
export const FRIDGE_ACTION_CLAUSE_RE =
  /^(?:帮?我)?(?:把|将)?(?:这些|那些)?(?:都|全|一起|一并|再)?(?:加进|放进|放入|放到|收进|存进|加入|添加到|录入|登记)(?:到|入)?(?:我的|冷藏|保鲜|冷冻|冰箱|冰柜)(?:里|中|内)?[吧哈呀了]?$/;

/**
 * 句尾动作残留：「…洋葱，帮我加进冰箱」「…鸡蛋放冰箱」。
 * 锚在句尾且必须带存放位置，所以裸动词（放/收/存/搁/塞）也能剥；
 * 名字结尾撞上这些字的家常食材一个都没有（harness 逐字校验词表）。
 */
export const FRIDGE_ACTION_TAIL_RE =
  /[，,]?\s*(?:帮?我)?(?:把|将)?(?:这些|那些)?(?:明天|后天|今天|晚上|早上|回头|待会儿|等会儿|等下|一会儿|会儿|再|就|先|都|全|一起|一并)*(?:加进|放进|放入|放到|收进|存进|加入|添加到|录入|登记|放|搁|收|存|塞|丢)(?:到|入)?(?:我的|冷藏|保鲜|冷冻|冰箱|冰柜)?(?:里|中|内)?[吧哈呀了]?$/;

/** 中文并列分隔符：、，, 和 及 以及 跟 */
export const LIST_DELIMITER_RE = /(?:以及|和|及|跟|、|，|,)+/;

/**
 * 主语 + 把字句头：「我买了…」「帮我把…」「我今天囤了…」。
 * 单条路径的主语剥离由 bareIngredientName 承担，批量路径剥完才能命中购买前缀，
 * 所以这条放在共享层，两边同一份剥法。
 */
export const INVENTORY_SUBJECT_RE =
  /^(?:帮?我|俺|咱们?|我们|您|你)?\s*(?:把|将)?\s*(?:这些|那些)?\s*/;

/**
 * 动作残留：一个「食材名」里只要出现录入动作、存放位置、时间状语或查询语气，
 * 这半句就是话术而不是菜名（「豌豆记得放冰箱」「鸡蛋怎么做」「明天再」）。
 *
 * Router 与 parser 共用这一条：剥离句式前后缀之后仍躲不掉残留的条目，
 * 一律判为解析失败退回 LLM，绝不把整截句子当名字写进冰箱。
 * 只列多字 token 与零歧义单字，词表里的家常食材（含「里脊」「花生」「起司」）
 * 一个都不命中；harness 逐字校验整张词表，防止以后加词时误伤。
 */
export const INGREDIENT_ACTION_RESIDUE_RE =
  /(?:帮|俺|咱|您|我|你|他|她|别|顺便|顺手|赶紧|马上|立刻|待会|会儿|先|再|然后|接着|继续|记得|忘记|忘了|需要|想要|打算|准备|计划|买|囤|入|放|搁|塞|挪|投|收|存|加|录|登|整理|清理|归置|带|拿|给|送|起来|一下|好|完|掉|冰箱|冰柜|冷藏|冷冻|保鲜|厨房|储物|柜|架子|这些|那些|全都|都是|全部|一起|一并|吧|哈哈|呀|啦|嘛|哦|嗯|的|了|到|回|怎么|怎样|咋|啥|哪|么|做|吃|喝|想|要|多少|贵|便宜|预算|够|明天|后天|今天|昨天|前天|大后天|下周|下个星期|周末|星期|礼拜)/;

/**
 * 常见生鲜食材词表：允许「番茄」「两个土豆」这类裸名词直接进入冰箱录入。
 * 只收录歧义度低的家庭常备食材；纸巾 / 洗衣液等日用品由 add_consumable 处理。
 * 导出给 harness 做「词表 × 残留守卫」互斥校验——加词时误伤立刻暴露。
 */
export const FRESH_INGREDIENT_NAMES = [
  '番茄', '西红柿', '土豆', '黄瓜', '茄子', '青椒', '辣椒', '胡萝卜', '白萝卜',
  '洋葱', '白菜', '生菜', '菠菜', '芹菜', '西兰花', '花菜', '冬瓜', '南瓜',
  '玉米', '豆角', '豌豆', '蘑菇', '香菇', '金针菇', '豆腐', '生姜', '大蒜',
  '大葱', '小葱', '香菜', '苹果', '香蕉', '橙子', '橘子', '葡萄', '西瓜',
  '草莓', '蓝莓', '猕猴桃', '芒果', '菠萝', '梨', '桃子', '鸡蛋', '牛奶',
  '酸奶', '猪肉', '牛肉', '羊肉', '鸡肉', '鸡腿', '鸡翅', '排骨', '五花肉',
  '火腿', '培根', '香肠', '鱼', '虾', '蟹', '贝类', '面条', '米粉', '饺子',
  '馄饨', '面包', '吐司', '芝士', '黄油', '奶油',
  // 调味油盐是厨房里的常备资源（消耗品侧另有词表，两边同名词不冲突）：
  // 「我橱柜里有盐和食用油」「牛肉、鸡蛋、盐」这两句以前都掉出门外 ——
  // 词表里没有食盐 / 食用油，Router 认不出这份名单，只能退回 chat 让 LLM 猜。
  '食盐', '食用油'
];

/**
 * 口语别名 → 词表里的规范名。只收「同一件东西的另一种叫法」这种零歧义映射，
 * 不做 ingredient ontology（不建层级、不做「油 → 植物油 / 动物油」的分裂）。
 *
 * 存在的理由只有一个：「盐」和「食盐」是同一件东西。若不归一，冰箱里就会
 * 同时躺着「盐」「食盐」两条记录，之后再怎么匹配菜谱都认不出来是自家的盐。
 */
export const INGREDIENT_NAME_ALIASES: Readonly<Record<string, string>> = {
  盐: '食盐',
  油: '食用油'
};

/** 词表名 / 别名 → 规范名（别名指向的名字必须已经在词表里，harness 逐条校验） */
export function canonicalIngredientName(word: string): string | null {
  if (FRESH_INGREDIENT_NAMES.includes(word)) return word;
  const alias = INGREDIENT_NAME_ALIASES[word];
  return alias && FRESH_INGREDIENT_NAMES.includes(alias) ? alias : null;
}

/**
 * 去掉数量与量词后，整句是否只剩一个已知食材名（「两个土豆」→「土豆」）。
 * 返回归一化后的名称，供 Router 判定与确定性解析共用同一份识别规则。
 */
export function bareIngredientName(message: string): string | null {
  const compact = message.replace(/\s/g, '').replace(/[。.!！~～]+$/, '');
  // 先按原词命中词表：「五花肉」的「五」是菜名的一部分，不是数量。
  const exact = canonicalIngredientName(compact);
  if (exact) return exact;
  const stripped = compact.replace(
    /^(?:来|要|给我|帮我)?\s*(?:\d+|[一二两三四五六七八九十]+)?\s*(?:个|斤|包|袋|盒|瓶|根|头|把|块|份|kg|克|克)?\s*/,
    ''
  );
  return canonicalIngredientName(stripped);
}

/**
 * 裸并列名单：「牛肉、豌豆」「牛肉和豌豆」「牛肉、鸡蛋和西红柿」——
 * 整句没有任何动词，纯由食材名并列组成。逐项复用 bareIngredientName
 * （同一份词表、同一层数量剥离），任一项不是纯食材名就整体不成立：
 * 漏判一句只是退回 chat 让用户换个说法，认错一项是把话术写进冰箱。
 */
export function bareIngredientListNames(message: string): string[] | null {
  const parts = message
    .trim()
    .split(LIST_DELIMITER_RE)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;

  const names: string[] = [];
  for (const part of parts) {
    const name = bareIngredientName(part);
    if (!name) return null;
    names.push(name);
  }
  return names;
}

/**
 * 「买了/刚买/采购了…」是完成态购买动词，属于明确的新现实录入：
 * 即使存在未完成的旧草稿也必须打断它，否则第二笔录入会被当成上一笔的字段补充，
 * 被 draft 分支拖进 LLM。裸食材名（「番茄」）没有这种确定性，
 * 草稿存在时仍按「在补字段」处理。
 *
 * 疑问守卫排在最前：录入是陈述行为，「冰箱里还有什么？」永远不是录入，
 * 不管有没有活跃草稿、句里有没有食材名。
 */
function looksLikeAddInventory(message: string, hasActiveDraft: boolean): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;
  if (RECORD_QUESTION_GUARD_RE.test(trimmed)) return false;
  const explicitPurchase =
    INVENTORY_KEYWORDS.some((k) => trimmed.includes(k)) ||
    FRIDGE_RECORD_ENTRY_RE.test(trimmed) ||
    FRIDGE_CLAIM_RE.test(trimmed);
  if (hasActiveDraft) return explicitPurchase;
  return (
    explicitPurchase ||
    bareIngredientName(trimmed) !== null ||
    bareIngredientListNames(trimmed) !== null
  );
}

function looksLikeAddReminder(message: string): boolean {
  return /提醒|备忘|记一下.*提醒/.test(message);
}

function looksLikeCreateLifeRecord(message: string): boolean {
  return /(今天|刚才|刚刚).{0,8}(完成|做完|经历了|去了|吃了)/.test(message);
}

/**
 * 路由入口。
 *
 * 返回值永远是 AITaskExtraction。
 * - chat 任务的 drafts 为 null。
 * - 其它任务的 drafts 可能为空数组（识别失败），此时 replyText 会提示用户。
 */
/**
 * 续采占位：Router 只声明「这句话属于哪个进行中的会话」，
 * 不在此处绑定字段 —— 字段绑定是 continue*Task 的职责（单一实现，不重复）。
 */
function continuationIntent(
  taskType: AITaskType,
  reason: string
): AITaskExtraction {
  return {
    intent: { taskType, confidence: 0.75, reason },
    drafts: { items: [] },
    replyText: '',
    requiresConfirmation: true,
    continuation: true
  };
}

/**
 * 卡片口令的响应形状：标记这次是「一次点击的等价物」，由前端对旧卡片执行
 * 与按钮同一个 commit / cancel 函数。
 *
 * 草稿内容一律不改、也不回显 —— 用户可能已经在卡片上编辑过，旧卡片才是唯一
 * 数据源，落地动作读的就是它自己的 drafts。把草稿带回响应反而制造幽灵卡片：
 * 用户刚说「算了」，新消息又渲染出一张内容相同、未取消的活卡，再点一次就写真实数据。
 */
function cardCommandExtraction(
  kind: CardKind,
  command: CardCommand,
  activeTask?: ActiveTaskSnapshot
): AITaskExtraction {
  const verb = command === 'confirm' ? '确认' : '取消';

  if (kind === 'shopping') {
    const items = activeTask?.shoppingDrafts ?? [];
    return {
      intent: {
        taskType: 'add_shopping_item',
        confidence: 0.98,
        reason: `采购卡片等待期间的${verb}口令`
      },
      drafts: { items: [] },
      replyText:
        command === 'confirm'
          ? `已把这 ${items.length} 件加进采购清单。`
          : '好，这次先不加。',
      requiresConfirmation: true,
      cardCommand: command
    };
  }

  const items = activeTask?.consumableDrafts ?? [];
  return {
    intent: {
      taskType: 'add_consumable',
      confidence: 0.98,
      reason: `消耗品卡片等待期间的${verb}口令`
    },
    drafts: { items: [] },
    replyText:
      command === 'confirm'
        ? `已登记${items.map((item) => item.name).join('、')}，临近用完时我会提醒你。`
        : '好，这条先不记。',
    requiresConfirmation: true,
    consumablePhase: 'confirming',
    cardCommand: command
  };
}

/**
 * 明确的新现实录入：用户在陈述一笔已完成的购买事实（或消耗品余量事实），
 * 不是在补充进行中的会话字段。
 * 「预算20元」「明天买」「改成两包」不含完成态购买动词，不会命中，仍走续采。
 */
const NEW_REALITY_RECORD_RE =
  /(买了|买回|购买了|购入了|采购了|囤了|入手了|新增了|刚买|新买)/;

/**
 * 没有待确认采购卡时的取消回应。
 *
 * 刻意不发 cardCommand：没有明确目标卡片的口令会让前端去取消一张不存在的卡，
 * 或者误命中另一条会话。空草稿 + 一句说明 —— 前端因 length 为 0 不渲染卡片，
 * 不写任何数据，也不进 LLM。
 */
function purchaseCancellationNotice(): AITaskExtraction {
  return {
    intent: {
      taskType: 'add_shopping_item',
      confidence: 0.95,
      reason: '取消采购：当前没有待确认的采购草稿'
    },
    drafts: { items: [] },
    replyText: '当前没有待确认的采购计划需要取消。',
    requiresConfirmation: false
  };
}

/**
 * 明确的新现实录入：陈述一笔已完成/已发生的事实，不是在补充进行中的会话字段。
 * 「预算20元」「明天买」「改成两包」不含完成态动词，不会命中，仍走续采。
 * 冰箱陈述/祈使句式同样是明确录入——但疑问句不算：守卫必须在此生效，
 * 否则「我们冰箱里还有什么？我想做意大利面」会被抢进录入通道。
 */
function isClearlyNewRealityRecord(message: string): boolean {
  return (
    NEW_REALITY_RECORD_RE.test(message) ||
    (!RECORD_QUESTION_GUARD_RE.test(message) &&
      (FRIDGE_RECORD_ENTRY_RE.test(message) || FRIDGE_CLAIM_RE.test(message))) ||
    looksLikeConsumableStatusUpdate(message, [])
  );
}

/**
 * 做饭能力查询：「我现在可以做什么」「有什么可以吃」「帮我看看能做什么」
 * 「根据现在的食材推荐」「我现在能做什么菜」。
 *
 * 两条同时成立才算：疑问/求建议语气（直接复用录入守卫那份判据，不另建词表），
 * 且句子落在「拿现有库存换一顿饭」的表达上。
 *
 * 反例：「我把盐买回来了，现在可以开始做了」—— 没有「做什么 / 能吃」的疑问结构，
 * 「开始做」是陈述自己接下来要干活，不是问库存，不会被当成查询抢走录入。
 */
const COOKING_CAPABILITY_QUERY_RE =
  /(?:可以|能|能够)做(?:什么|啥)?(?:菜)?|做什么|做啥|(?:煮|炒|焖|炖|蒸)(?:什么|啥)|有什么(?:可以|能)?吃|什么(?:可以|能)吃|(?:可以|能)?吃(?:什么|啥|点什么|些什么)|(?:看看|看)(?:能|可以)?做(?:点|些)?(?:什么|啥)?|(?:食材|库存|冰箱|厨房|家里)[^，。；]{0,8}(?:推荐|建议|搭配)/;

/**
 * 陈述式做饭能力查询的两条附加判据。
 *
 * 「看看现在能做的菜」没有问号、也没有「什么 / 吗 / 推荐」这类疑问线索，
 * RECORD_QUESTION_GUARD_RE 抓不到它，于是整句被消耗品词表接走 —— 这正是 Bug 2。
 * 陈述式比疑问式更容易误伤，所以这里额外收紧：
 *   ① 必须指向当下库存（现在 / 手头 / 这些 / 食材 / 冰箱…），「以后能做什么菜」不算；
 *   ② 句中带购买动词一律不算 —— 购物请求不许从这里被抢走。
 * 「帮我买包纸巾好吗」两条都不满足（也没有落在做饭表达上），仍是 add_shopping_item。
 */
const COOKING_PRESENT_CONTEXT_RE =
  /(?:现在|此刻|目前|眼下|手头|手上|现有|这些|那些|家里|冰箱|厨房|食材|库存|剩)/;

const PURCHASE_REQUEST_RE = /(?:买|囤|下单|入手|购入|补货|采购)/;

export function isCookingCapabilityQuery(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  if (!COOKING_CAPABILITY_QUERY_RE.test(text)) return false;
  // 疑问式：沿用录入守卫那份判据，行为完全不变
  if (RECORD_QUESTION_GUARD_RE.test(text)) return true;
  // 陈述式：当下指涉 + 非购买请求，两条同时成立才算
  return COOKING_PRESENT_CONTEXT_RE.test(text) && !PURCHASE_REQUEST_RE.test(text);
}

export function routeAITask(
  context: AITaskContext
): AITaskExtraction {
  // 开发调试（开发环境可见，生产环境无隐私泄露）
  const debug = typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';

  // 0. 卡片口令：确认卡片正在等用户点头时，「确认 / 算了」就是按钮的等价物。
  //    必须排在所有语义路由之前 —— 否则这句话掉进 chat，LLM 口头答应「已记录」，
  //    而真正的写入者（前端 commit）永远不会被触发。
  const command = readCardCommand(context.message);
  const pendingCard = command ? pendingCardOf(context.activeTask) : null;
  if (command && pendingCard) {
    if (debug) console.debug('[AI Task]', { taskType: pendingCard, reason: `卡片口令：${command}` });
    return cardCommandExtraction(pendingCard, command, context.activeTask);
  }

  // 0.5 采购否定守卫 —— 必须排在所有现实录入分支之前。
  //
  //    为什么不能等到第 4 步的续采分支再判：第 2 步命中就直接 return，
  //    而「面巾纸不用买了」里的「买了」是「不用买 + 语气词了」的子串巧合，
  //    必然命中 BOUGHT_KEYWORDS。守卫写在续采层里等于永远不生效。
  //
  //    命中后只有两个去向，都不碰正向 parser：
  //    - 有采购会话 → 交给 continueShoppingTask 执行条目移除 / 整卡取消
  //    - 无采购会话 → 一句说明。
  //
  //    消耗品会话与食材草稿进行中不拦：「不用了」「不要了」这类含糊拒绝
  //    本来就在各自会话里作废当前条目，抢过来会让 Q8 那类既有用例走空。
  const pendingShopping = context.activeTask?.shoppingDrafts ?? [];
  const removal = detectItemRemoval(context.message, pendingShopping);
  if (
    readPurchaseCancellation(context.message) ||
    removal.matched.length > 0 ||
    removal.unknown.length > 0
  ) {
    if (hasActiveShoppingSession(context.activeTask)) {
      if (debug) console.debug('[AI Task]', { taskType: 'add_shopping_item', reason: '取消采购：绑定进行中的采购会话' });
      return continuationIntent('add_shopping_item', '取消采购：绑定进行中的采购会话执行移除');
    }
    if (!hasActiveConsumableSession(context.activeTask) && !context.hasActiveInventoryDraft) {
      if (debug) console.debug('[AI Task]', { taskType: 'add_shopping_item', reason: '取消采购：无待确认草稿' });
      return purchaseCancellationNotice();
    }
  }

  // 1. 消耗品状态更新（最高优先：用户陈述的是已存在条目的余量事实）
  const consumableNames = (context.consumables ?? []).map((c) => c.name);
  if (looksLikeConsumableStatusUpdate(context.message, consumableNames)) {
    if (debug) console.debug('[AI Task]', { taskType: 'update_consumable_status', reason: 'status phrase + consumable name' });
    return runUpdateConsumableStatusTask(context);
  }

  // 1.5 采购完成（complete_purchase）—— 必须排在消耗品录入之前。
  //
  //     「我把盐和食用油都买回来了，现在可以开始做了」里的盐和油确实在消耗品词表里，
  //     但用户报的是**到手**，不是「请帮我建档」。落到第 2 步就会被追问存放位置、
  //     多久用完 —— 正是真人测试翻车的地方。这两样都不是采购完成的必要条件。
  //
  //     判据由任务自己持有：采购完成说法 + 点名的东西确实还挂在清单上。
  //     对不上清单就返回 null，原样退回下面的路由 —— 不凭空造入库卡。
  //     产出仍是待确认草稿，用户点头之后才写厨房库存（草稿 ≠ 现实数据）。
  const restock = runPurchaseCompleteTask(context);
  if (restock) {
    if (debug) console.debug('[AI Task]', { taskType: 'complete_purchase', reason: restock.intent.reason });
    return restock;
  }

  // 1.5+ 做饭能力查询 —— 必须排在消耗品 / 采购清单录入词表之前。
  //
  //     「我刚买的食用油能做什么」里的「买的 + 食用油」会被第 2 步整句接走，
  //     接下来追问存放位置、多久用完 —— 可用户问的是「能做什么」，不是「请建档」。
  //     判据本身很窄（见 isCookingCapabilityQuery：既要求落在「拿现有库存换一顿饭」
  //     的表达上，也排除购买意图），宁可漏判也不误伤录入。
  //
  //     同一判据也继续挡在 active task continuation（第 4 步）之前，为的就是打断
  //     低优先级 pending 会话：新高置信意图 > 继续追问旧卡片。卡片不会因这次打断
  //     消失，用户随时可以说「确认加入厨房」或点按钮。
  //     食材确认草稿进行中不抢：那时这句话就是在回答卡片自己的提问。
  if (!command && isCookingCapabilityQuery(context.message) && !context.hasActiveInventoryDraft) {
    if (debug) console.debug('[AI Task]', { taskType: 'chat', reason: '做饭能力查询：打断进行中的低优先级会话' });
    return {
      intent: {
        taskType: 'chat',
        confidence: 0.9,
        reason: '做饭能力查询（读当前厨房真实库存），打断进行中的低优先级会话'
      },
      drafts: null,
      replyText: '',
      requiresConfirmation: false
    };
  }

  // 2. 已购买消耗品（优先于购物/食材）
  if (looksLikeAddConsumable(context.message)) {
    if (debug) console.debug('[AI Task]', { taskType: 'add_consumable', reason: 'purchased consumable phrase' });
    return runAddConsumableTask(context);
  }

  // 3. 采购清单（只有纯未来意图才进入，已修复 looksLikeAddShoppingItem）。
  //    进行中的采购会话不在这里处理：交给第 4 步合并，否则「明天买」这类
  //    只补时间、不含新物品的回答会被当成一次解析失败的全新采购。
  if (
    !hasActiveShoppingSession(context.activeTask) &&
    looksLikeAddShoppingItem(context.message)
  ) {
    if (debug) console.debug('[AI Task]', { taskType: 'add_shopping_item', reason: 'future shopping intent' });
    return runAddShoppingItemTask(context);
  }

  // 4. Active Task continuation —— 优先级：明确的新 Action Intent
  //    > active task continuation > 泛化关键词 fallback。
  //    「20 天提醒我一次」是在回答消耗品会话的提问，不是新建提醒；
  //    「预算 20 块」是在补采购草稿，不是闲聊。
  //    但「今天买了两个番茄」是新的现实录入，必须放行重新路由，
  //    不能被进行中的旧会话当成字段补充吞掉。
  //    这里只负责「归给谁」，真正的字段绑定由 route 层调用 continue*Task 完成。
  if (!isClearlyNewRealityRecord(context.message)) {
    if (hasActiveConsumableSession(context.activeTask)) {
      if (debug) console.debug('[AI Task]', { taskType: 'add_consumable', reason: '绑定进行中的消耗品会话' });
      return continuationIntent('add_consumable', '绑定进行中的消耗品会话（续采）');
    }
    if (hasActiveShoppingSession(context.activeTask)) {
      if (debug) console.debug('[AI Task]', { taskType: 'add_shopping_item', reason: '绑定进行中的采购会话' });
      return continuationIntent('add_shopping_item', '绑定进行中的采购会话（补充字段）');
    }
  }

  // 5. 提醒语义（占位：本次不实现）
  if (looksLikeAddReminder(context.message)) {
    return {
      intent: {
        taskType: 'add_reminder',
        confidence: 0.6,
        reason: '命中提醒关键词（add_reminder 占位，本次未实现）'
      },
      drafts: null as never,
      replyText:
        '提醒功能正在搭建中，本次先帮你记下来。',
      requiresConfirmation: true
    };
  }

  // 6. 生活记录语义（占位：本次不实现）
  if (looksLikeCreateLifeRecord(context.message)) {
    return {
      intent: {
        taskType: 'create_life_record',
        confidence: 0.6,
        reason: '命中生活记录语义（占位，本次未实现）'
      },
      drafts: null as never,
      replyText:
        '生活记录模块正在搭建中，本次先不写入。',
      requiresConfirmation: true
    };
  }

  // 7. 食材录入语义
  if (looksLikeAddInventory(context.message, !!context.hasActiveInventoryDraft)) {
    return {
      intent: {
        taskType: 'add_inventory',
        confidence: 0.85,
        reason: '命中食材购买/录入关键词（add_inventory）'
      },
      drafts: { items: [] },
      replyText: '',
      requiresConfirmation: true
    };
  }

  // 8. 默认 chat
  return {
    intent: {
      taskType: 'chat',
      confidence: 0.5,
      reason: '未命中任何 Action Task，回退到 chat'
    },
    drafts: null,
    replyText: '',
    requiresConfirmation: false
  };
}

export type { AITaskType, AITaskExtraction };