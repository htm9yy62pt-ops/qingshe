/**
 * Replenishment Decision — 购买推荐决策（纯函数，零外部依赖）
 *
 * 输入：
 * - consumable: 当前消耗品
 * - lifeResources: 用户已保存好店 (from qingshe_life_resources)
 * - context: 当前场景（是否紧急、是否有 tag 匹配）
 *
 * 输出：
 * - urgency: 'urgent' | 'planned'
 * - options: PurchaseOption[]（按优先级排序）
 *
 * 设计原则：
 * - 不接地图/API
 * - 复用已有 LifeResource.tags
 * - 不创建假商城（qingshe_store 只做 disabled / coming soon）
 */

import type { ConsumableItem } from '@/lib/types/consumable';
import type { LifeResource } from '@/lib/types/life-resource';
import { PURCHASE_LEAD_DAYS } from '../reality/reminder-engine';

export type PurchaseOptionType = 'my_store' | 'qingshe_store' | 'nearby_store';

export interface PurchaseOption {
  type: PurchaseOptionType;
  title: string;
  description: string;
  priority: number; // 越小越优先
  resourceId?: string;
}

export interface ReplenishmentDecision {
  urgency: 'urgent' | 'planned';
  options: PurchaseOption[];
  message: string;
}

// MVP 关键词映射：消费品名 → 可能的标签
const NAME_TAG_MAP: Record<string, string[]> = {
  '面巾纸': ['日用品', '清洁用品'],
  '纸巾': ['日用品', '清洁用品'],
  '卫生纸': ['日用品', '清洁用品'],
  '洗衣液': ['日用品', '清洁用品'],
  '洗洁精': ['日用品', '清洁用品'],
  '生抽': ['调料'],
  '老抽': ['调料'],
  '蚝油': ['调料'],
  '味精': ['调料'],
  '食用油': ['调料', '食材'],
  '厕所纸': ['日用品'],
};

function getTagsForName(name: string): string[] {
  for (const [key, tags] of Object.entries(NAME_TAG_MAP)) {
    if (name.includes(key)) return tags;
  }
  return ['日用品'];
}

function scoreResource(resource: LifeResource, tags: string[]): number {
  const resTags = (resource.tags ?? []).map((t) => t.toLowerCase());
  let score = 0;
  for (const tag of tags) {
    const tl = tag.toLowerCase();
    if (resTags.some((rt) => rt.includes(tl) || tl.includes(rt))) {
      score += 10;
    }
  }
  if (resource.isFavorite) score += 3;
  return score;
}

export function buildReplenishmentDecision(
  consumable: ConsumableItem,
  lifeResources: LifeResource[],
  estimatedRunOutDays?: number
): ReplenishmentDecision {
  const urgency: 'urgent' | 'planned' =
    (estimatedRunOutDays != null && estimatedRunOutDays <= PURCHASE_LEAD_DAYS)
      ? 'urgent'
      : 'planned';

  const tags = getTagsForName(consumable.name);
  const namedResources = lifeResources.filter(
    (r) => (r.tags ?? []).length > 0 || r.isFavorite
  );

  const matched = namedResources
    .map((r) => ({ resource: r, score: scoreResource(r, tags) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score);

  const options: PurchaseOption[] = [];

  // 1. 我的好店（最高优先级）
  if (matched.length > 0) {
    for (const m of matched.slice(0, 2)) {
      options.push({
        type: 'my_store',
        title: `你常去的店：${m.resource.name}`,
        description: `你通常会在这里购买${tags[0] ?? '日用品'}。${m.resource.url ? '可以直接访问链接购物。' : ''}`,
        priority: 1,
        resourceId: m.resource.id
      });
    }
  } else if (lifeResources.length > 0) {
    // 无 tag 匹配时，随机推荐一个已保存的好店
    const r = lifeResources[0];
    options.push({
      type: 'my_store',
      title: `你常去的店：${r.name}`,
      description: `你通常会在这里购买日用品。` ,
      priority: 1,
      resourceId: r.id
    });
  }

  // 2. 轻舍好店（占位，未来接入）
  options.push({
    type: 'qingshe_store',
    title: '轻舍好店',
    description: '未来根据性价比推荐更适合的购买渠道。即将支持。',
    priority: 2
  });

  // 3. 附近便利店（占位）
  options.push({
    type: 'nearby_store',
    title: '附近便利店',
    description: '可以去附近便利店补充。未来接 Location / Places API。',
    priority: 3
  });

  const message = urgency === 'urgent'
    ? `⚠️ 你的${consumable.name}快用完了。预计还剩 ${estimatedRunOutDays ?? '不多'} 天，记得及时补充哦。`
    : `你的${consumable.name}预计还有 ${estimatedRunOutDays ?? '一段时间'} 才会用完。可以提前规划补充。`;

  return { urgency, options, message };
}