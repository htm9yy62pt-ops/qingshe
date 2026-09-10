/**
 * Qingshe Reality Data Routing 统一类型。
 *
 * 设计目的：
 * - 为未来 AI Intent 输出提供"数据归属"统一抽象。
 * - 单一数据来源（localStorage key）只能有一个 Canonical Owner。
 * - 路由层只判断归属，不做实际写入。
 *
 * 严禁：
 * - 在该模块直接访问 localStorage
 * - 在该模块拼接 AI Prompt
 * - 在该模块修改任何 Service 的业务逻辑
 */

export type RealityDomain =
  | 'home' // 家里（实物资源）
  | 'outside' // 家外（外部资源 / 好店）
  | 'reminder' // 提醒（待办、清单）
  | 'solution' // 方案（统一方案领域）
  | 'record'; // 记录（个人生活记录）

export type RealityResource =
  | 'ingredient'
  | 'recipe'
  | 'home_item'
  | 'consumable'
  | 'life_resource'
  | 'shopping_list'
  | 'solution'
  | 'life_record';

export type RealityAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'complete'
  | 'consume';

/**
 * 统一归属目标。
 * storageKey 与 service 均为可选：
 *  - 当前已存在的资源提供具体 key 与 service
 *  - 未来资源（home_item / consumable）只预留 domain + resource
 */
export interface RealityDataTarget {
  domain: RealityDomain;
  resource: RealityResource;
  storageKey?: string;
  service?: string;
}