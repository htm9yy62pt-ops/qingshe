import { RealityDataType } from './intent';
import { chatWithAI } from './service';
import { parseChineseNumber } from './tasks/shopping-task';
import {
  bareIngredientName,
  FRIDGE_ACTION_CLAUSE_RE,
  FRIDGE_ACTION_TAIL_RE,
  FRIDGE_CLAIM_RE,
  INGREDIENT_ACTION_RESIDUE_RE,
  INVENTORY_RECORD_PREFIX_RE,
  INVENTORY_SUBJECT_RE,
  KITCHEN_REGION_WORD_ALT,
  kitchenLocationOf,
  LIST_DELIMITER_RE,
  RECORD_QUESTION_GUARD_RE,
  type KitchenStorageLocation
} from './tasks/task-router';
import type { ShoppingListItem } from '@/lib/types/shopping-list';
import type { InventoryIngredient } from '@/lib/types/ingredient';

export type RecordStatus = "collecting" | "confirming";

export interface IngredientRecordData {
  name?: string;
  quantity?: number;
  unit?: string;
  category?: string;
  price?: number;
  purchaseDate?: string;
  expiryDate?: string;
  location?: string;
}

export interface IngredientRecordDraft {
  type: "ingredient";
  status: RecordStatus;
  data: IngredientRecordData;
  missingFields: string[];
}

/**
 * 明确的食材现实录入 → 确定性解析（零 LLM）。
 *
 * 覆盖两种高置信结构：
 * 1. 「(时间)(主语)(完成态购买动词) + [数量][单位] + 短名称」
 * 2. 裸食材名（「番茄」「两个土豆」）—— 与 Router 的 add_inventory 判定同源
 * 任何偏差（模糊量词、长句、未来意图）返回 null，
 * 由调用方 fallback 到 extractIngredientRecord，保留复杂语义理解能力。
 */
const INVENTORY_QTY_UNIT_RE =
  /^(\d+|[一二两三四五六七八九十]+)\s*(箱|包|袋|盒|瓶|个|斤|份|桶|罐|支|卷|提|块|根|公斤|kg|g|升|L)?\s*/;

const VAGUE_INVENTORY_NAME_RE = /^(?:一些|一点|点|好多|很多|不少|若干|东西|吃的|菜)/;

/** 名单条目：数量+单位在名称前（「2个西红柿」）或在后（「西红柿2个」） */
const ITEM_QTY_UNIT_ALT = '箱|包|袋|盒|瓶|个|斤|份|桶|罐|支|卷|提|块|根|把|公斤|kg|g|升|L';
const ITEM_QTY_PREFIX_RE = new RegExp(`^(\\d+|[一二两三四五六七八九十]+)\\s*(${ITEM_QTY_UNIT_ALT})?\\s*(.+)$`);
const ITEM_QTY_SUFFIX_RE = new RegExp(`^(.+?)\\s*(\\d+|[一二两三四五六七八九十]+)\\s*(${ITEM_QTY_UNIT_ALT})$`);

/** 拆不出数量段的名单条目，名字里再出现这些字符就不是食材名，是整句残缺 */
const LIST_ITEM_BAD_CHAR_RE = /[。；;！!？?、，,\d一二两三四五六七八九十半些]/;

/**
 * 否定/存在动词开头不是菜名：「有没有牛肉」剥掉一层「有」之后剩下「没有牛肉」，
 * 光看字符它是干净的 —— 必须在这里拦住，否则整句会被当成两行库存写进去。
 * 「无花果」这类真菜名用得起「无」，所以表里不收它。
 */
const LIST_ITEM_NEGATION_HEAD_RE = /^(?:没|不|有)/;

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

/** 前缀段里的购买日期语义：昨天/前天回推真实日期，其余（含无时间词）都是 today */
function purchaseDateFromPrefix(prefix: string): string {
  return prefix.includes('前天')
    ? isoDaysAgo(2)
    : prefix.includes('昨天')
      ? isoDaysAgo(1)
      : 'today';
}

export function tryParseInventoryRecord(
  message: string
): IngredientRecordData | null {
  const text = message.trim().replace(/[。！!？?～~]+$/, '');
  const prefix = text.match(INVENTORY_RECORD_PREFIX_RE);

  // 无购买动词时只接受裸食材名，数量缺省 1（「番茄」→ 今天 1 个番茄）
  if (!prefix) {
    const bare = bareIngredientName(text);
    if (!bare) return null;
    const bareQty = text.match(INVENTORY_QTY_UNIT_RE);
    const bareQuantity = bareQty ? parseChineseNumber(bareQty[1]) : undefined;
    return {
      purchaseDate: 'today',
      quantity: bareQuantity ?? 1,
      unit: bareQty?.[2] ?? '',
      name: bare
    };
  }

  let rest = text.slice(prefix[0].length);
  if (!rest) return null;

  const data: IngredientRecordData = { purchaseDate: purchaseDateFromPrefix(prefix[0]) };

  const qty = rest.match(INVENTORY_QTY_UNIT_RE);
  if (qty) {
    const quantity = parseChineseNumber(qty[1]);
    if (quantity === undefined) return null;
    data.quantity = quantity;
    if (qty[2]) data.unit = qty[2];
    rest = rest.slice(qty[0].length);
  }

  const name = rest.trim();
  // 含并列标记说明这是名单，单条解析绝不吞下「牛肉、豌豆」「牛肉和豌豆」当菜名 ——
  // 那是批量函数的职责，这里硬吞就等于把第二样东西从名字里抹掉。
  // 含动作残留（「今天买了牛肉记得放冰箱」）同理：那是半句话，不是名字。
  if (
    !name ||
    name.length > 12 ||
    LIST_DELIMITER_RE.test(name) ||
    /[；;]/.test(name) ||
    VAGUE_INVENTORY_NAME_RE.test(name) ||
    INGREDIENT_ACTION_RESIDUE_RE.test(name)
  ) {
    return null;
  }
  data.name = name;
  return data;
}

/**
 * 单个名单条目 → 食材记录。「西红柿」「2个西红柿」「西红柿2个」「一斤牛肉」；
 * 拆不出数量段时，名字里不许再有任何数字、标点或残余量词。
 */
function parseListItem(raw: string): IngredientRecordData | null {
  const text = raw.trim();
  if (!text) return null;

  const build = (name: string, quantity: number | undefined, unit: string) => {
    const item: IngredientRecordData = {
      name,
      quantity: quantity ?? 1,
      unit,
      purchaseDate: 'today'
    };
    return item;
  };
  const validName = (name: string) =>
    !!name &&
    name.length <= 8 &&
    !VAGUE_INVENTORY_NAME_RE.test(name) &&
    !LIST_ITEM_BAD_CHAR_RE.test(name) &&
    !INGREDIENT_ACTION_RESIDUE_RE.test(name) &&
    !LIST_ITEM_NEGATION_HEAD_RE.test(name) &&
    !/了$/.test(name);

  /*
   * 词表优先：「五花肉」的「五」是菜名的一部分，不是数量。
   * 共享识别器能整句认出的名字（Router / 单条解析同一份词表）直接采用，
   * 只有数量段后面还跟着真量词时才剥数量 —— 否则「五」会被当成数量吃掉。
   */
  const known = bareIngredientName(text);
  if (known) {
    const qty = text.match(INVENTORY_QTY_UNIT_RE);
    const quantity = qty?.[2] ? parseChineseNumber(qty[1]) : undefined;
    return quantity === undefined
      ? build(known, undefined, '')
      : build(known, quantity, qty![2]);
  }

  const leading = text.match(ITEM_QTY_PREFIX_RE);
  if (leading) {
    const quantity = parseChineseNumber(leading[1]);
    const name = leading[3].trim();
    if (quantity !== undefined && validName(name)) {
      return build(name, quantity, leading[2] ?? '');
    }
    return null;
  }
  const trailing = text.match(ITEM_QTY_SUFFIX_RE);
  if (trailing) {
    const quantity = parseChineseNumber(trailing[2]);
    const name = trailing[1].trim();
    if (quantity !== undefined && validName(name)) {
      return build(name, quantity, trailing[3] ?? '');
    }
    return null;
  }
  if (!validName(text)) return null;
  return build(text, undefined, '');
}

/** 并列名单 → 多条记录。少于两项不是名单，交给调用方按单条处理。 */
function parseIngredientList(chunk: string): IngredientRecordData[] | null {
  const parts = chunk.split(LIST_DELIMITER_RE).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const items: IngredientRecordData[] = [];
  for (const part of parts) {
    const item = parseListItem(part);
    if (!item) return null;
    items.push(item);
  }
  return items;
}

/* ════════════════════════════════════════════════════════════════════
 * P1-2a 厨房资源 Parser：把「冰箱批量」扩成「按储存区域的厨房批量」
 * ════════════════════════════════════════════════════════════════════ */

/**
 * 用户说出口的储存区域（类型与区域词表都在共享识别层 `tasks/task-router`）：
 * Router 用它认「橱柜里有…」这种陈述式录入，本文件用它按区域切句 ——
 * 一份词典两处读，Parser 侧不再长出第二套区域词表。
 *
 * 「未指定」不是一种位置，是没有位置：词表查不到、句子里没说，就留 undefined，
 * 绝不拿「生鲜默认冷藏」替用户做主。
 */
export type { KitchenStorageLocation };

/**
 * 一次区域声明 = 「(现在)(我的)位置词 (+里|中|室|下)」+「(现在|还|都)」+「(有|放了|装着|多了…)」。
 * 状语两头都要放行：共享 claim 正则吃得下「我现在冰箱里有」，只把状语挂在位置词后面就漏掉这一种，
 * 「我先」会被当成没有位置的前置名单，整串解析当场作废。
 * 位置词必须紧咬存在动词才算声明：「常温牛奶」「冷冻水饺」里的位置字只是菜名的一部分。
 */
const KITCHEN_CLAIM_ADVERB = '(?:现在|目前|还|都|已经|又|新|就)?\\s*';
const KITCHEN_REGION_CLAIM_SOURCE =
  KITCHEN_CLAIM_ADVERB +
  '(?:我们|我|咱们|咱|您|你)?\\s*(?:的)?\\s*' +
  `(${KITCHEN_REGION_WORD_ALT})` +
  '(?:里面|里|内|中|室|下)?\\s*' +
  KITCHEN_CLAIM_ADVERB +
  '(?:都|全)?\\s*' +
  '(?:有|放了|放着|装着|装了|多了|新添了|添了|摆着)';

/** 一个区域分片：这一截名单属于哪个储存位置（undefined = 用户没提位置） */
interface KitchenRegionSlice {
  location: KitchenStorageLocation | undefined;
  text: string;
}

/**
 * 「冰箱里有鸡蛋、鸭蛋，橱柜里有食盐、鸡精」—— 每个区域声明各领走自己那段名单，
 * 区域自己的 storageLocation 跟着名单走，不串到下一段去。
 * 首个声明之前的文本无可继承位置，location 为 undefined。
 */
function splitKitchenRegions(clause: string): KitchenRegionSlice[] {
  const re = new RegExp(KITCHEN_REGION_CLAIM_SOURCE, 'g');
  const marks: Array<{
    start: number;
    end: number;
    location: KitchenStorageLocation | undefined;
  }> = [];
  for (let hit = re.exec(clause); hit !== null; hit = re.exec(clause)) {
    if (hit.index === re.lastIndex) {
      re.lastIndex += 1;
      continue;
    }
    marks.push({ start: hit.index, end: re.lastIndex, location: kitchenLocationOf(hit[1]) });
  }
  if (marks.length === 0) return [{ location: undefined, text: clause }];

  const slices: KitchenRegionSlice[] = [];
  const head = clause.slice(0, marks[0].start).trim();
  if (head) slices.push({ location: undefined, text: head });
  marks.forEach((mark, i) => {
    const to = i + 1 < marks.length ? marks[i + 1].start : clause.length;
    slices.push({ location: mark.location, text: clause.slice(mark.end, to) });
  });
  return slices;
}

/**
 * 纯存在句的句头（「我有…」「家里现在有…」「还有…」）。
 * 只处理位置声明之外的语气，剥不动就原样交回下游 —— 这里不认「有」是食材名的一部分。
 */
const KITCHEN_HAVE_CLAIM_RE =
  /^(?:现在|目前|还|都|已经|又|新)?(?:家里|家中|家)?有(?:了|着)?\s*/;

/**
 * 录入动作的纯修饰尾：共享尾句守卫的动词表吃得下「放进冰箱」，修饰表里却只有「全」没有「全部」，
 * 「帮我全部放进冰箱」剥完动词只剩「，帮我全部」。这一截里没有任何食材，
 * 在厨房 Parser 本地丢掉即可，不去动 Router 与单条解析共用的那张表。
 */
const KITCHEN_ACTION_MODIFIER_TAIL_RE =
  /[，,、]?\s*(?:就|再|然后|顺便|顺手|马上|立刻)?\s*(?:帮|请|给)?\s*(?:我|你)?\s*(?:把|将)?\s*(?:这些|那些)?\s*(?:全部|都|一并|一起|统统)?\s*$/;

/** 一截名单正文 + 它所属的储存位置（undefined = 用户没提位置） */
interface KitchenSliceBody {
  location: KitchenStorageLocation | undefined;
  body: string;
}

/**
 * 分句 → 剥动作尾句 → 按区域切分 → 剥声明与主语，产出「区域 + 名单正文」。
 *
 * 批量 Parser 与 `looksLikeParallelInventoryList` 共用这一条剥法：结构判定和
 * 解析判定各写一遍，迟早漂移成两种口径 —— 一边认它是名单、另一边认不出，
 * 半成品卡就从缝里漏出去。
 * 返回 null = 这句根本不该进厨房批量（疑问句 / 空句）。
 */
function kitchenSliceBodies(message: string): {
  bodies: KitchenSliceBody[];
  sawActionClause: boolean;
} | null {
  // 查询保护：「我冰箱里有什么？」是在问现实，不是告诉现实（守卫与 Router 共用一份）
  if (RECORD_QUESTION_GUARD_RE.test(message)) return null;

  const clauses = message
    .split(/[。；;！!\n]+/)
    .map((c) => c.trim())
    .filter(Boolean);
  if (clauses.length === 0) return null;

  const bodies: KitchenSliceBody[] = [];
  let sawActionClause = false;

  for (const raw of clauses) {
    const clause = raw.replace(/[？?～~]+$/, '');
    // 先剥动作尾句，剩下什么才算什么：剥空了是纯动作分句，只贡献录入意图；
    // 剥完还剩名单就继续解析。顺序反了会把「牛肉，放进冰箱」整句当动作丢掉。
    const noTail = clause.replace(FRIDGE_ACTION_TAIL_RE, '');
    if (noTail !== clause) sawActionClause = true;
    // 尾句守卫只剥到动词为止，剩下的纯修饰（「，帮我全部」）不属于名单
    const trimmed = (
      noTail === clause ? noTail : noTail.replace(KITCHEN_ACTION_MODIFIER_TAIL_RE, '')
    ).trim();
    if (!trimmed) {
      if (FRIDGE_ACTION_CLAUSE_RE.test(clause)) sawActionClause = true;
      continue;
    }

    for (const slice of splitKitchenRegions(trimmed)) {
      /*
       * 区域声明已在切分时剥掉，claim 前缀（「我现在冰箱里有…」）同样只是位置声明。
       * 主语/把字头必须排在 claim 之后剥：先剥主语会把「我现在冰箱里有」削成
       * 「现在冰箱里有」，位置声明不再成立，整串名单就散了。
       */
      const claim = slice.text.match(FRIDGE_CLAIM_RE);
      const body = (
        claim ? slice.text.slice(claim[0].length) : slice.text.replace(INVENTORY_SUBJECT_RE, '')
      )
        .replace(KITCHEN_HAVE_CLAIM_RE, '')
        .trim();
      if (body) bodies.push({ location: slice.location, body });
    }
  }

  return { bodies, sawActionClause };
}

/**
 * 厨房 Reality 批量录入：一句话、多区域、多项食材 → 多条确定性记录（零 LLM）。
 *
 * 接受四种句式来源（冰箱/购买/裸名单与 Router 同源，见 task-router）：
 * - 陈述：「我现在冰箱里有牛肉、豌豆，帮我加进冰箱」（claim 前缀 + 动作尾句）
 * - 购买名单：「今天我买了牛肉、豌豆和鸡蛋」（购买前缀 + 并列名单）
 * - 裸名单：「牛肉、豌豆、鸡蛋」
 * - 多区域：「我的冰箱里现在有鸡蛋、鸭蛋；橱柜里有食盐、鸡精」（区域分片 + 各自名单）
 *
 * 契约与单条版一致且更严：任一非空分片解析失败就**整批**返回 null，
 * 一项都不留下。调用方拿到 null 之后也不许改用单条 / LLM 出口硬凑一张卡 ——
 * 多项句的半成品比重新问一句更坏（见 `looksLikeParallelInventoryList`）。
 * 只解析出一项时要求句子里确有录入动作（「牛肉，放进冰箱」），
 * 否则交回单条链路，不从这里抢语义。
 */
export function tryParseKitchenInventoryRecords(
  message: string
): IngredientRecordData[] | null {
  const parsed = kitchenSliceBodies(message);
  if (!parsed) return null;

  const items: IngredientRecordData[] = [];

  for (const { location, body } of parsed.bodies) {
    const pfx = body.match(INVENTORY_RECORD_PREFIX_RE);
    const list = parseIngredientList(pfx ? body.slice(pfx[0].length) : body);
    if (list) {
      const purchaseDate = purchaseDateFromPrefix(pfx?.[0] ?? '');
      items.push(
        ...list.map((item) => ({ ...item, ...(location ? { location } : {}), purchaseDate }))
      );
      continue;
    }

    const single = tryParseInventoryRecord(body);
    if (single) {
      items.push(location ? { ...single, location } : single);
      continue;
    }
    // 任一非空分片解析失败 → **整批作废**，已经解析出来的条目一条都不留。
    // 「牛肉、鸡蛋、认不出的东西」只回牛肉鸡蛋，等于谎报「你家冰箱里没有后两样」；
    // 半张确认卡比重新问一句更坏 —— 数据完整性不是「能记多少记多少」。
    return null;
  }

  if (items.length >= 2) return items;
  // 「帮我放进一些牛肉，放进冰箱」：单项 + 动作分句也是完整的批量语境
  if (items.length === 1 && parsed.sawActionClause) return items;
  return null;
}

/**
 * 这句话的结构本身就是「并列多料名单」：剥完区域声明 / 主语 / 购买前缀之后，
 * 某一截里仍然并列着 ≥2 项。
 *
 * 存在的唯一理由是把降级路径钉死在事实完整性上：批量解析弃权时，调用方手上
 * 只剩单条解析和 LLM 提取两个出口，而它们都**只回一项**。对一句列了三样东西的话
 * 来说，那不是在降级，是在悄悄丢掉两样 —— 真人测试里「牛肉、鸡蛋、盐」只长出
 * 一张「牛肉」确认卡，就是这条出口走出来的。多项句 + 批量失败必须拦住，
 * 整批重新问一次，也不发半成品卡。
 */
export function looksLikeParallelInventoryList(message: string): boolean {
  const parsed = kitchenSliceBodies(message);
  if (!parsed) return false;
  return parsed.bodies.some(({ body }) => {
    const pfx = body.match(INVENTORY_RECORD_PREFIX_RE);
    const rest = pfx ? body.slice(pfx[0].length) : body;
    return rest.split(LIST_DELIMITER_RE).map((part) => part.trim()).filter(Boolean).length >= 2;
  });
}

/**
 * P0.5-1 起的兼容入口：chat route / onboarding / harness 都认这个名字。
 * 冰箱是厨房的一个区域，不是两套解析器 —— 旧名直接转调厨房 Parser。
 */
export function tryParseInventoryRecords(
  message: string
): IngredientRecordData[] | null {
  return tryParseKitchenInventoryRecords(message);
}

/**
 * 从用户消息中提取食材记录信息
 */
export async function extractIngredientRecord(
  message: string, 
  existingDraft?: IngredientRecordDraft
): Promise<IngredientRecordData> {
  const apiKey = process.env.AMD_AI_API_KEY;
  const model = process.env.AMD_AI_MODEL;

  if (!apiKey || !model) {
    throw new Error('Missing AMD AI API configuration');
  }

  // 构建系统提示词
  let systemPrompt = `你是轻舍 Qingshe 的现实生活数据提取器。
任务是从用户消息中提取"食材购买/添加记录"信息。
如果存在 existingDraft，用户的新消息可能是在补充 previous missing fields，必须结合 existingDraft 更新数据。
不要回答用户，不要生成解释，只返回严格 JSON。

数据字段说明：
- name: 食材名称（必须）
- quantity: 数量（可选，如果用户未提及则为 null）
- unit: 单位（可选，如果用户未提及则为 null）
- category: 类别（可选，AI 可根据名称推断，如果不确定则为 null）
- price: 价格（必须，如果用户未提及则为 null）
- purchaseDate: 购买日期（如果用户未提及则为 "today"）
- expiryDate: 过期日期（必须，如果用户未提及则为 null）
- location: 存放位置（可选，如果用户未提及则为 null）

日期处理：
- 如果用户说"30天后过期"，返回 expiryDaysFromNow: 30，程序会转换为具体日期
- 如果用户说"今天购买"，返回 purchaseDate: "today"
- 如果用户说"下周五过期"，返回 expiryDate: "next_friday"，程序会转换为具体日期

返回格式：
{
  "data": {
    "name": "牛奶",
    "quantity": 1,
    "unit": "盒",
    "category": "奶制品",
    "price": null,
    "purchaseDate": "today",
    "expiryDate": null,
    "location": "冷藏",
    "expiryDaysFromNow": 30
  }
}

如果字段未知必须返回 null，不允许编造。`;

  // 如果存在现有草稿，添加到系统提示词中
  if (existingDraft) {
    systemPrompt += `
    
现有草稿数据：
${JSON.stringify(existingDraft.data, null, 2)}

请结合以上草稿数据，根据用户的新消息更新或补充信息。`;
  }

  try {
    const aiResponse = await chatWithAI({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ],
      temperature: 0.1,
      maxTokens: 512
    });

    try {
      // 尝试解析 AI 返回的内容
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const extractedData = JSON.parse(jsonMatch[0]);
        return extractedData.data || extractedData;
      } else {
        console.error('Failed to extract JSON from extract record response:', aiResponse);
        throw new Error('Invalid JSON format in response');
      }
    } catch (jsonError) {
      console.error('Failed to parse extract record response as JSON:', aiResponse);
      throw new Error('Failed to parse extract record response as JSON');
    }
  } catch (error) {
    console.error('Error in extractIngredientRecord:', {
      errorInfo: error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
            cause: (error as any).cause,
          }
        : {
            message: String(error),
          }
    });

    throw error;
  }
}

/**
 * 构建食材记录草稿
 */
export function buildIngredientDraft(
  extractedData: IngredientRecordData,
  existingDraft?: IngredientRecordDraft
): IngredientRecordDraft {
  // 合并现有草稿和新提取的数据
  const combinedData: IngredientRecordData = {
    ...(existingDraft?.data || {}),
    ...extractedData
  };

  // 处理日期转换
  const processedData = processDates(combinedData);

  // 计算缺失字段。
  // 事实录入只强制名称：数量默认 1、购买日期默认今天，价格与保质期是可选补充 ——
  // 追问它们会把一句明确的「今天买了2个番茄」拖成多轮表单。
  const missingFields: string[] = [];
  if (!processedData.name) missingFields.push('name');

  // 确定状态
  const status: RecordStatus = missingFields.length > 0 ? 'collecting' : 'confirming';

  return {
    type: 'ingredient',
    status,
    data: processedData,
    missingFields
  };
}

/**
 * 处理日期相关的字段转换
 */
function processDates(data: IngredientRecordData): IngredientRecordData {
  const result = { ...data };

  // 处理购买日期
  if (result.purchaseDate === 'today') {
    result.purchaseDate = new Date().toISOString().split('T')[0];
  }

  // 处理过期日期
  if (result.expiryDate === 'today') {
    result.expiryDate = new Date().toISOString().split('T')[0];
  } else if (typeof result.expiryDate === 'string' && result.expiryDate.startsWith('next_')) {
    // 这里可以根据需要实现特定的日期计算逻辑
    // 例如 'next_monday', 'next_friday' 等
    // 暂时保持原样，实际应用中需要完善
  }

  // 如果有 expiryDaysFromNow，则计算具体的过期日期
  if (typeof (data as any).expiryDaysFromNow === 'number') {
    const daysFromNow = (data as any).expiryDaysFromNow;
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + daysFromNow);
    result.expiryDate = expiryDate.toISOString().split('T')[0];
  }

  return result;
}

/* ------------------------------------------------------------------ *
 * P0-B 回程：采购清单 item → 冰箱入库
 *
 * Shopping List 里被勾选「已购买」的 item 经由这两个纯函数接回既有的
 * Ingredient Confirm Card / saveIngredients 链路。不新建状态机：
 * - 「已购买」只生成 confirming 草稿，用户确认后才写真实库存；
 * - 幂等锚点是 ShoppingListItem.restockedAt —— 已入库的 item 永不再出卡；
 * - recipe / ai / manual 来源走同一函数，不按来源分叉；
 * - quantity / unit 有则带入，没有则留空，绝不编造。
 * ------------------------------------------------------------------ */

/** 旧 recipe 链路的 quantity 是展示串（'4个（约200g）'）：只取前导数字与紧跟的短单位，括号备注一律不进字段 */
const RESTOCK_QTY_RE = /^\s*(\d+(?:\.\d+)?)\s*([^\s（(]{0,4})/;

export function shoppingItemToRestockDraft(
  item: ShoppingListItem
): IngredientRecordDraft | null {
  // 只有「已购买」才可能入库；勾选前移交给调用方判定，这里再兜一道。
  if (item.status !== 'purchased') return null;
  // 幂等：确认入库过的 item 不再产生第二张卡。
  if (item.restockedAt) return null;

  const name = item.name.trim();
  if (!name) return null;

  const data: IngredientRecordData = {
    name,
    // 采购日期即本次入库的事实时间（勾选/确认当天），不是编造字段。
    purchaseDate: new Date().toISOString().split('T')[0]
  };

  if (typeof item.quantity === 'number') {
    data.quantity = item.quantity;
  } else if (typeof item.quantity === 'string') {
    const m = RESTOCK_QTY_RE.exec(item.quantity);
    if (m) data.quantity = Number(m[1]);
  }

  const explicitUnit = item.unit?.trim();
  if (explicitUnit) {
    data.unit = explicitUnit;
  } else if (typeof item.quantity === 'string') {
    // 数量串里紧跟的短单位（'4个（约200g）' 的 '个'）是展示的一部分，显式 unit 字段优先。
    const m = RESTOCK_QTY_RE.exec(item.quantity);
    if (m?.[2]) data.unit = m[2];
  }

  const category = item.category?.trim();
  if (category) data.category = category;

  return { type: 'ingredient', status: 'confirming', data, missingFields: [] };
}

/**
 * confirming 草稿 → 真实库存记录（确认按钮按下后的写入库形状）。
 *
 * 与 chat 页 SAVE_INGREDIENT 分支同构，但缺的信息不补默认值：
 * chat 页的 expiry/storageLocation 是服务端从用户原话里提取的，
 * 这里没有提取来源，编出来就是假数据 —— 留空，由冰箱页自行补充。
 */
export function inventoryIngredientFromRestockDraft(
  draft: IngredientRecordDraft
): InventoryIngredient {
  const d = draft.data;
  const today = new Date().toISOString().split('T')[0];
  return {
    id: `ingredient_restock_${Date.now()}`,
    name: d.name ?? '',
    quantity: d.quantity != null ? String(d.quantity) : '',
    unit: d.unit ?? '',
    category: d.category ?? '其他',
    purchaseDate: d.purchaseDate ?? today,
    expiryDate: '',
    storageLocation: '',
    createdAt: today
  };
}