import { ShoppingList, ShoppingListItem } from '@/lib/types/shopping-list';
import { LifeResource, LifeResourceType } from '@/lib/types/life-resource';
import {
  ShoppingDecision,
  ShoppingResourceMatch,
  ShoppingRecommendationReason
} from '@/lib/types/shopping-decision';

/**
 * 少量 MVP 关键词映射，用于把常见采购物品关联到用户好店 tag。
 * 不做大型商品知识库，也不使用 AI 推断。
 */
const ITEM_TAG_HINTS: Record<string, string[]> = {
  生抽: ['调料'],
  老抽: ['调料'],
  盐: ['调料'],
  糖: ['调料'],
  料酒: ['调料'],
  醋: ['调料'],
  蚝油: ['调料'],
  香油: ['调料'],
  洋葱: ['蔬菜', '食材'],
  番茄: ['蔬菜', '食材'],
  西红柿: ['蔬菜', '食材'],
  土豆: ['蔬菜', '食材'],
  青菜: ['蔬菜', '食材'],
  黄瓜: ['蔬菜', '食材'],
  蒜: ['食材', '调料'],
  姜: ['食材', '调料'],
  葱: ['食材', '调料'],
  垃圾袋: ['日用品'],
  纸巾: ['日用品'],
  洗衣液: ['日用品']
};

const IMMEDIATE_STORE_TYPES: LifeResourceType[] = ['supermarket', 'market', 'local_store'];
const PLANNED_STORE_TYPES: LifeResourceType[] = ['online_store'];

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * 获取某件采购物品可能对应的 tag 集合。
 * 来源：
 * 1. 物品自带 category
 * 2. MVP 关键词映射（item.name 包含关键词或关键词包含 item.name）
 */
function getItemTags(item: ShoppingListItem): string[] {
  const tags = new Set<string>();

  if (item.category && item.category.trim().length > 0) {
    tags.add(normalize(item.category));
  }

  const itemName = normalize(item.name);

  Object.entries(ITEM_TAG_HINTS).forEach(([keyword, hintTags]) => {
    const normalizedKeyword = normalize(keyword);
    if (
      itemName.includes(normalizedKeyword) ||
      normalizedKeyword.includes(itemName)
    ) {
      hintTags.forEach((tag) => tags.add(normalize(tag)));
    }
  });

  return Array.from(tags);
}

function hasTagMatch(item: ShoppingListItem, resource: LifeResource): boolean {
  const itemTags = getItemTags(item);
  const resourceTags = (resource.tags ?? []).map(normalize);

  if (itemTags.length === 0 || resourceTags.length === 0) {
    return false;
  }

  return itemTags.some((itemTag) =>
    resourceTags.some(
      (resourceTag) =>
        resourceTag.includes(itemTag) || itemTag.includes(resourceTag)
    )
  );
}

function isImmediateType(type: LifeResourceType): boolean {
  return IMMEDIATE_STORE_TYPES.includes(type);
}

function isPlannedType(type: LifeResourceType): boolean {
  return PLANNED_STORE_TYPES.includes(type);
}

function buildMatch(
  resource: LifeResource,
  matchedItems: string[]
): ShoppingResourceMatch {
  const reasons: ShoppingRecommendationReason[] = [];

  if (matchedItems.length > 0) {
    reasons.push('matching_tag');
  }

  if (isImmediateType(resource.type) || isPlannedType(resource.type)) {
    reasons.push('store_type');
  }

  if (resource.isFavorite) {
    reasons.push('favorite');
  }

  if (reasons.length === 0) {
    reasons.push('general');
  }

  // 排序权重：tag 匹配数量 > 场景类型匹配 > 收藏加成
  const tagScore = matchedItems.length * 10;
  const sceneScore =
    isImmediateType(resource.type) || isPlannedType(resource.type) ? 2 : 0;
  const favoriteScore = resource.isFavorite ? 1 : 0;

  return {
    resourceId: resource.id,
    resourceName: resource.name,
    resourceType: resource.type,
    matchedItems,
    score: tagScore + sceneScore + favoriteScore,
    reasons
  };
}

/**
 * 根据购物清单和用户好店生成采购决策。
 * 纯函数，不调用 AI，不访问地图或第三方 API。
 */
export function buildShoppingDecision(
  shoppingList: ShoppingList,
  lifeResources: LifeResource[]
): ShoppingDecision {
  const pendingItems = shoppingList.items.filter((item) => item.status === 'pending');

  const immediateOptions: ShoppingResourceMatch[] = [];
  const plannedOptions: ShoppingResourceMatch[] = [];
  const matchedItemNames = new Set<string>();

  lifeResources.forEach((resource) => {
    const matchedItems = pendingItems
      .filter((item) => hasTagMatch(item, resource))
      .map((item) => item.name);

    if (matchedItems.length === 0) {
      return;
    }

    matchedItems.forEach((name) => matchedItemNames.add(name));

    const match = buildMatch(resource, matchedItems);

    if (isImmediateType(resource.type)) {
      immediateOptions.push(match);
    } else if (isPlannedType(resource.type)) {
      plannedOptions.push(match);
    }
  });

  const sortByScore = (
    a: ShoppingResourceMatch,
    b: ShoppingResourceMatch
  ): number => b.score - a.score;

  const unmatchedItems = pendingItems
    .filter((item) => !matchedItemNames.has(item.name))
    .map((item) => item.name);

  return {
    shoppingListId: shoppingList.id,
    immediateOptions: immediateOptions.sort(sortByScore),
    plannedOptions: plannedOptions.sort(sortByScore),
    unmatchedItems,
    generatedAt: new Date().toISOString()
  };
}