/**
 * Consumable 多轮收集会话（无状态纯函数模块）
 *
 * 职责：把用户对「放在哪里 / 大概多久用完 / 多久提醒一次」的回答
 * 绑定到进行中的 ConsumableDraft 上，并决定会话是继续追问还是进入确认。
 *
 * 关键约束（产品规则）：
 * - 消耗品不问保质期、不问价格（那是食品 Ingredient Draft 的字段）。
 * - 必问：storageLocation + (estimatedRunOutDays 或 checkIntervalDays 二选一)。
 */

import type { ConsumableDraft, ConsumableSessionPhase } from './types';

export type { ConsumableSessionPhase };

export interface ConsumableSessionResult {
  drafts: ConsumableDraft[];
  replyText: string;
  phase: ConsumableSessionPhase;
}

const CN_NUM: Record<string, number> = {
  一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

function parseDays(text: string): number | null {
  const m = text.match(/(\d+)\s*天/);
  if (m) return Number(m[1]);
  const cn = text.match(/([一二两三四五六七八九十]{1,2})\s*天/);
  if (cn && CN_NUM[cn[1]] !== undefined) return CN_NUM[cn[1]];
  return null;
}

function extractLocationPhrase(sentence: string): string | null {
  const m = sentence.match(/(?:放在?|放到|搁在|收纳在|收在)([^，。;；\n]+)/);
  if (!m) return null;
  return m[1].replace(/(了|吧|呢|。|，)$/g, '').trim() || null;
}

/** 把一条用户回复绑定到所有 pending drafts 上（按名字前缀优先，否则广播） */
export function applyConsumableSessionReply(
  drafts: ConsumableDraft[],
  message: string
): ConsumableSessionResult {
  const next = drafts.map((d) => ({ ...d }));
  const sentences = message.split(/[，。;；\n]/).map((s) => s.trim()).filter(Boolean);

  // 1. location：逐句匹配「X放在Y」；无主语的「放在Y / 都放在Y」广播到缺 location 的 drafts
  for (const sentence of sentences) {
    const matched = next.filter((d) => sentence.includes(d.name));
    const loc = extractLocationPhrase(sentence);
    if (!loc) continue;
    if (matched.length > 0) {
      matched.forEach((d) => {
        if (!d.location) d.location = loc;
      });
    } else if (/放在?|放到|搁在|收纳在|收在/.test(sentence)) {
      next.forEach((d) => {
        if (!d.location) d.location = loc;
      });
    }
  }

  // 2. 消耗节奏：「X天用完」→ runOut；「X天提醒一次」→ checkInterval（runOut 优先）
  for (const sentence of sentences) {
    const days = parseDays(sentence);
    if (days === null) continue;
    if (/用完|用光|耗尽|用得完/.test(sentence)) {
      next.forEach((d) => {
        if (d.estimatedRunOutDays === undefined) d.estimatedRunOutDays = days;
      });
    } else if (/提醒/.test(sentence)) {
      next.forEach((d) => {
        if (d.estimatedRunOutDays === undefined && d.checkIntervalDays === undefined) {
          d.checkIntervalDays = days;
        }
      });
    }
  }

  // 3. 依据绑定结果刷新 missingFields / status
  next.forEach((d) => {
    const missing: ConsumableDraft['missingFields'] = [];
    if (!d.location) missing.push('location');
    if (d.estimatedRunOutDays === undefined && d.checkIntervalDays === undefined) {
      missing.push('run_out_estimate');
    }
    d.missingFields = missing;
    d.status = missing.length === 0 ? 'ready' : 'collecting';
  });

  return buildSessionResult(next);
}

/** 新一批 add_consumable 命中时，把解析出的新物品并入进行中的会话（按名字去重） */
export function mergeConsumableDrafts(
  existing: ConsumableDraft[],
  incoming: ConsumableDraft[]
): ConsumableDraft[] {
  const merged = existing.map((d) => ({ ...d }));
  for (const item of incoming) {
    const hit = merged.find((d) => d.name === item.name);
    if (hit) {
      if (item.quantity !== undefined) hit.quantity = item.quantity;
      if (item.unit !== undefined) hit.unit = item.unit;
    } else {
      merged.push({ ...item });
    }
  }
  return merged;
}

function buildSessionResult(drafts: ConsumableDraft[]): ConsumableSessionResult {
  const pending = drafts.filter((d) => d.status !== 'ready');

  if (pending.length > 0) {
    const noLocation = pending.filter((d) => !d.location);
    const noRhythm = pending.filter(
      (d) => d.estimatedRunOutDays === undefined && d.checkIntervalDays === undefined
    );
    const label = (list: ConsumableDraft[]) =>
      list.map((d) => d.name).join('、');
    const many = pending.length > 1;

    let replyText = '';
    if (noLocation.length > 0 && noRhythm.length > 0) {
      // 一次问全：用户可以一句话回答「都放储物间，大概一个月用完」
      replyText = `${label(noLocation)}${many ? '分别' : ''}放在哪里？大概多久会用完？\n不确定的话，告诉我你希望多久提醒你检查一次。`;
    } else if (noLocation.length > 0) {
      replyText = `${label(noLocation)}${many ? '分别' : ''}放在哪里？`;
    } else if (noRhythm.length > 0) {
      replyText =
        `${label(noRhythm)}大概什么时候会用完？` +
        '不确定的话，你希望我多久提醒你检查一次？';
    }
    return { drafts, replyText, phase: 'collecting' };
  }

  const summary = drafts
    .map((d) => {
      const rhythm =
        d.estimatedRunOutDays !== undefined
          ? `约 ${d.estimatedRunOutDays} 天后用完`
          : `每 ${d.checkIntervalDays} 天提醒检查`;
      return `· ${d.name}${d.quantity ? ` ×${d.quantity}` : ''}（${d.location}，${rhythm}）`;
    })
    .join('\n');
  return {
    drafts,
    replyText: `已记录以下消耗品，请确认：\n${summary}\n确认后我会保存并在临近耗尽时提醒你。`,
    phase: 'confirming',
  };
}