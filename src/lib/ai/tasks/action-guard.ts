/**
 * 否定口令守卫（action guard）
 *
 * 职责：识别「不做了」类口令，翻译成对待确认卡片的操作意图。
 * 只做识别与匹配，不碰任何数据 —— 丢弃、移除还是反问，由调用方
 * （route.ts 分诊层 / active-task.ts 续采层）决定。
 *
 * 四条通道：
 * - readDiscardCommand：带对象词的丢弃（「取消采购清单」）。纯句口令
 *   （「取消」「算了」）走 confirmation.readCardCommand，这里显式让路。
 * - readPurchaseCancellation：整句是否在表达「放弃采购」（「算了，不买牙膏了」）。
 *   分句判定，不依赖草稿，因此可以站在路由层前面。
 * - detectItemRemoval：条目级移除（「纸巾不要了」）。分句扫描，只在有待采草稿时有意义。
 * - isNegatedPurchase：单个分句的否定采购（「不想买纸巾」）。给 shopping / consumable
 *   parser 用 —— 否定的句子绝不能变成一条正向草稿。
 */
import { normalizeCardCommand, readCardCommand } from '@/lib/ai/confirmation';

export type DiscardTarget = 'shopping' | 'consumable' | 'ingredient';

/**
 * 带对象词的丢弃：动词 +（范围）+（域）+（名词），整句锚定。
 *
 * 「取消采购清单」不是纯句，口令通道接不住；落进续采会被当成补字段，
 * 卡片原地不动。这里把「动词+对象」的复合口令接住，解析出指向的卡片。
 */
const DISCARD_WITH_OBJECT_RE =
  /^(?:取消|清空|撤掉|删除|删掉|作废|移除)(?:一下)?(全部|所有|这些|那些|这条|这个)?(采购|购物|待买|消耗品|食材)?(清单|记录|登记|条目)?(?:里|中|上)?$/;

export function readDiscardCommand(
  message: string
): { target: DiscardTarget | null } | null {
  // 纯句口令归 cardCommand 通道管，守卫不抢
  if (readCardCommand(message)) return null;
  const normalized = normalizeCardCommand(message);
  if (!normalized) return null;
  const m = DISCARD_WITH_OBJECT_RE.exec(normalized);
  if (!m) return null;
  const domain = `${m[2] ?? ''}${m[3] ?? ''}`;
  const target: DiscardTarget | null = /采购|购物|待买|清单/.test(domain)
    ? 'shopping'
    : /消耗品|登记/.test(domain)
      ? 'consumable'
      : /食材|记录/.test(domain)
        ? 'ingredient'
        : null;
  return { target };
}

/* ------------------------------------------------------------------ *
 * 分句与话语标记
 *
 * 「算了，不买牙膏了」的「算了」是对自己说话的起手式，既不是商品也不是采购对象。
 * 整句锚定的正则对它无解：normalizeCardCommand 把逗号抹平而不是切开，于是
 * 前缀式被开头的「算了」挡住、后缀式因句子以商品名结尾而失配 —— 守卫空手而归，
 * 剩下的文本一路掉进正向 parser，产出「算」「不买牙膏」两条幽灵商品。
 *
 * 因此守卫层自己分句：先剥句首话语标记，再按标点切开，逐句判定。
 * 注意不切「和 / 与 / 跟 / 及」—— 那是同一句里的并列商品，交给 fragments 处理。
 * ------------------------------------------------------------------ */

/** 句首话语标记。长词在前，否则「那算了」会被「算了」吃掉后半、留下孤零零的「那」。 */
const DISCOURSE_MARKER_RE = /^(?:那算了|算了还是|那好|好吧|算了|反正|其实|就是|那)\s*/;

/** 守卫层分句：中英文逗号 / 顿号 / 分号 / 句末标点 / 空白 */
function splitGuardClauses(message: string): string[] {
  return message.split(/[，,、；;。.！!？?\s]+/).filter(Boolean);
}

/** 循环剥离句首话语标记（「那算了」剥掉「那」后还剩「算了」，要再剥一层） */
function stripDiscourseMarkers(clause: string): string {
  let out = clause.trim();
  for (let pass = 0; pass < 3; pass += 1) {
    const before = out;
    out = out.replace(DISCOURSE_MARKER_RE, '').trim();
    if (out === before) break;
  }
  return out;
}

/** 分句后的句尾语气残留：normalizeCardCommand 的剥除只作用于整句末尾，切开后要补一刀 */
const CLAUSE_TRAILING_PARTICLE_RE = /(了|吧|呢|啊|呀|哦|噢|哈|啦|呗|的)+$/;

/* ------------------------------------------------------------------ *
 * 整体取消采购
 *
 * 判据是「这句话整体是不是在放弃采购」，与商品名无关，所以它不依赖草稿，
 * 可以站在 router 所有现实录入分支之前 —— 这正是 Bug 2 的正解：
 * 「面巾纸不用买了」里的「买了」是「不用买 + 语气词了」的子串巧合，
 * 消耗品分支只要排在守卫后面就会被它抢走。
 * ------------------------------------------------------------------ */

/** 采购行为动词：出现即说明这个分句在谈「买不买」 */
const PURCHASE_VERB_RE = /买|采购|购物|囤|入手|下单|加购|补货/;

/**
 * 否定 + 采购行为。给整句取消判定和 parser 闸门共用一份，避免两处词表跑偏。
 *
 * 前缀剥离救不了这类句子 —— 「不想买纸巾」剥掉「想」就剩「买纸巾」，
 * 反而更像正向采购。裸「不」只允许直接接 买 / 加 / 记 / 录，
 * 再宽就会把「差不多要买」这类非否定句一起吞掉。
 */
const NEGATED_PURCHASE_RE =
  /(?:不想|不要|不需要|不用|别|没|先不)(?:买|加|记|录|要)|不(?:买|加|记|录)/;

/** 裸放弃：整句没有采购动词，但语义就是「这事先作罢」 */
const BARE_ABANDON_RE = /^(?:不用了?|不需要了?|不要了|不做了|先不用|不用|不需要)$/;

export function readPurchaseCancellation(message: string): boolean {
  const clauses = splitGuardClauses(message);
  if (clauses.length === 0) return false;

  let purchaseClauses = 0;
  let negatedPurchaseClauses = 0;

  for (const raw of clauses) {
    const clause = stripDiscourseMarkers(raw);
    if (!clause) continue;

    if (PURCHASE_VERB_RE.test(clause)) {
      purchaseClauses += 1;
      if (NEGATED_PURCHASE_RE.test(clause)) negatedPurchaseClauses += 1;
      continue;
    }
    if (BARE_ABANDON_RE.test(clause)) return true;
  }

  // 全句都在谈采购、且没有任何一个分句是正向采购 —— 才叫放弃采购。
  // 「我不买纸巾，我要买垃圾袋」有正向分句，属于复合动作（Phase C），
  // 这里刻意不认领它，避免为了支持混合动作重新打开 NEGATE → ADD 的 fallthrough。
  return purchaseClauses > 0 && negatedPurchaseClauses === purchaseClauses;
}

export interface ItemRemoval {
  /** 命中、应移除的草稿名 */
  matched: string[];
  /** 口令提到了、但草稿里没有的物品词 —— 调用方应回「清单里没有」，且不得新建条目 */
  unknown: string[];
}

/** 「不要纸巾」「别买纸巾」—— 否定词在前 */
const REMOVE_PREFIX_RE =
  /^(?:不需要买|不用买|不想买|不要买|先不买|别买|不买|不要|不想|不用|不需要|别|去掉|删掉|删除|移除|撤掉)([\u4e00-\u9fa5A-Za-z0-9]{1,12})$/;
/** 「纸巾不要了」「垃圾袋别买了」—— 否定词在后（normalizeCardCommand 已剥句尾「了」） */
const REMOVE_SUFFIX_RE =
  /^([\u4e00-\u9fa5A-Za-z0-9]{1,12})(?:不想买了?|不要买了?|不需要买了?|不用买了?|别买了?|不买了?|不要了?|算了)$/;

/**
 * 条目级移除：逐句抽出被否定的物品片段，与待采草稿按名字匹配。
 *
 * 匹配用双向包含（「纸巾」命中「厨房纸巾」，反之亦然），因为用户报的是
 * 简称；匹配不上不算移除、算 unknown —— 宁可回一句「清单里没有」，
 * 也不能把这句再喂给商品提取，否则「纸巾不要了」会凭空建出一条纸巾。
 */
export function detectItemRemoval(
  message: string,
  drafts: { name: string }[]
): ItemRemoval {
  const matched: string[] = [];
  const unknown: string[] = [];

  const push = (frag: string) => {
    const hit = drafts.find(
      (d) => d.name === frag || d.name.includes(frag) || frag.includes(d.name)
    );
    if (hit) {
      if (!matched.includes(hit.name)) matched.push(hit.name);
    } else if (!unknown.includes(frag)) {
      unknown.push(frag);
    }
  };

  for (const raw of splitGuardClauses(message)) {
    const clause = normalizeCardCommand(stripDiscourseMarkers(raw));
    if (!clause) continue;
    const m = REMOVE_PREFIX_RE.exec(clause) ?? REMOVE_SUFFIX_RE.exec(clause);
    if (!m) continue;
    const fragments = m[1]
      .split(/[和与跟、及]/)
      .map((s) =>
        s.replace(/(全部|所有|这些|那些)$/, '').replace(CLAUSE_TRAILING_PARTICLE_RE, '').trim()
      )
      .filter((s) => s.length > 0);
    // 「不买了」这类裸否定在整句锚定下会捕获到一个「了」—— 它不是商品名，
    // 是整句取消，归 readPurchaseCancellation 管，不能报成 unknown 去反问用户。
    for (const frag of fragments) push(frag);
  }

  return { matched, unknown };
}

/**
 * 否定采购（分句级闸门）：给 shopping / consumable parser 用。
 * 「买了」是已购语义（归 inventory），不含否定词，不会被误伤。
 */
export function isNegatedPurchase(segment: string): boolean {
  return NEGATED_PURCHASE_RE.test(segment);
}