/**
 * Reminder Reality Model
 *
 * Reminder 不只是普通 to-do。本阶段至少支持 4 种类型：
 * - normal：普通单次提醒（未来 add_reminder 任务使用）
 * - recurring：固定周期提醒（房租、滤芯）
 * - reality_check：Reality Check 提醒（让轻舍定期询问消耗情况）
 * - replenishment：补货提醒（预计用完前提前购买）
 *
 * MVP 阶段实现 reality_check + replenishment；其它类型保留类型占位。
 *
 * 不实现：
 * - 真实 Push Notification 引擎
 * - Web Push / Mobile Push
 * - 后端 scheduler
 *
 * 只提供数据模型，未来 notification engine 可以消费。
 */

export type ReminderType =
  | 'normal'
  | 'recurring'
  | 'reality_check'
  | 'replenishment';

export type ReminderStatus = 'active' | 'completed' | 'cancelled';

export type ReminderResourceType = 'consumable';

export interface Reminder {
  id: string;

  title: string;

  type: ReminderType;

  status: ReminderStatus;

  /** 单次提醒的具体提醒时间（ISO 字符串）。 */
  remindAt?: string;

  /** 周期提醒间隔（天数）。例如 reality_check 20 天一次。 */
  intervalDays?: number;

  /**
   * 提醒下次触发时间（computed）；可选存储。
   * 对于 recurring / reality_check 必备。
   */
  nextTriggerAt?: string;

  /** Reality Resource Association。 */
  resourceType?: ReminderResourceType;
  resourceId?: string;

  /**
   * 提醒触发的动作描述（前端可消费）：
   * - 'check_consumption'：询问用户消耗情况
   * - 'replenish'：提醒购买
   * - 'normal'：普通文本提醒
   */
  action?: string;

  createdAt: string;
  updatedAt: string;
}