/**
 * Consumable Reality Model
 *
 * 区别于 Ingredient（食材）：Consumable 的核心问题不是"什么时候过期"，
 * 而是"什么时候会用完"。
 *
 * MVP 字段说明：
 * - quantity/unit: 可选。现实中"买了一些纸巾"不需要精确数量。
 * - location: 用户放置位置（储物室 / 厨房 / 卫生间...）。
 * - purchasedAt: ISO 字符串；可选，但 reminder 推导需要它。
 * - estimatedRunOutDays: 用户当前预计多久后用完（天数）。
 * - estimatedRunOutAt: 由 purchasedAt + estimatedRunOutDays 推导，可不存。
 * - checkIntervalDays: 用户不知道多久用完时，多久询问一次。
 * - lastCheckedAt / nextCheckAt: 周期询问状态。
 * - status: 反映该 Consumable 当前的学习阶段。
 *
 * 字段全部可选 / 允许"不知道"，保持 localStorage JSON 向后兼容。
 */

export type ConsumableStatus =
  | 'unknown' // 用户暂未提供任何用完时间信息
  | 'learning' // 已记录但刚开始学习消耗速度
  | 'estimated' // 用户已给出预计用完时间
  | 'running_low' // 即将用完（按 estimated 推导）
  | 'finished'; // 已用完

export interface ConsumableItem {
  id: string;
  name: string;

  /** 可选。允许 string | number，向后兼容 Recipe/Shopping 等旧格式。 */
  quantity?: number | string;
  unit?: string;

  location?: string;

  purchasedAt?: string;

  /** 用户当前预计多久后用完（天数）。 */
  estimatedRunOutDays?: number;

  /** 推导字段：purchasedAt + estimatedRunOutDays。如不存可运行时算。 */
  estimatedRunOutAt?: string;

  /** 用户不知道多久用完时，多久询问一次（天数）。 */
  checkIntervalDays?: number;

  lastCheckedAt?: string;
  nextCheckAt?: string;

  status: ConsumableStatus;

  /** 旧数据兼容字段：本阶段未使用，留作未来扩展。 */
  category?: string;

  createdAt: string;
  updatedAt: string;
}