import {
  RealityDataTarget,
  RealityResource
} from './types';

/**
 * 资源归属表。
 *
 * 关键规则（Storage Ownership Rule）：
 * - 每个 localStorage key 只能由一个 service 负责。
 * - 路由层只做"数据应该属于哪里"的判断，不直接读写。
 * - 真实读写必须经过对应 service（如 @/lib/reality/ingredients）。
 */
const REALITY_ROUTING: Record<RealityResource, RealityDataTarget> = {
  ingredient: {
    domain: 'home',
    resource: 'ingredient',
    storageKey: 'qingshe_ingredients',
    service: 'ingredients'
  },
  recipe: {
    domain: 'home',
    resource: 'recipe',
    storageKey: 'qingshe_my_recipes',
    service: 'recipes'
  },
  home_item: {
    domain: 'home',
    resource: 'home_item',
    storageKey: 'qingshe_home_items'
  },
  consumable: {
    domain: 'home',
    resource: 'consumable',
    storageKey: 'qingshe_consumables'
  },
  life_resource: {
    domain: 'outside',
    resource: 'life_resource',
    storageKey: 'qingshe_life_resources',
    service: 'life-resources'
  },
  shopping_list: {
    domain: 'reminder',
    resource: 'shopping_list',
    storageKey: 'qingshe_shopping_lists',
    service: 'shopping-lists'
  },
  solution: {
    domain: 'solution',
    resource: 'solution',
    service: 'solutions'
  },
  life_record: {
    domain: 'record',
    resource: 'life_record',
    storageKey: 'qingshe_life_records',
    service: 'life-records'
  }
};

/**
 * 解析某个资源应该归属于哪个 domain / service / storage。
 * 纯函数，不做副作用，可被 AI Intent 处理或页面使用。
 */
export function resolveRealityTarget(
  resource: RealityResource
): RealityDataTarget {
  return REALITY_ROUTING[resource];
}

/**
 * 获取所有受支持资源（便于调试 / 文档展示）。
 */
export function listRealityResources(): RealityResource[] {
  return Object.keys(REALITY_ROUTING) as RealityResource[];
}