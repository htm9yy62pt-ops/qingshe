/**
 * Qingshe AI Task Foundation
 *
 * 设计目标：
 * - 最小化、可扩展、零依赖（不引入 LangChain / Agent 框架）。
 * - 明确 AI Input → Intent → Task Extraction → Draft → User Confirmation → Reality Service → Storage
 *   的生命周期。
 * - 任务类型 (AITaskType) 与具体 Task 实现 (AITask) 解耦：
 *   - router 只负责"选任务"
 *   - 任务模块负责"提取 draft"
 *   - 任务模块负责"渲染 confirmation UI 元素"
 *   - 任务模块负责"通过 Reality Service 提交"
 *
 * 当前实现任务：
 * - chat             : 默认对话（无副作用）
 * - add_inventory    : 食材录入（旧 REALITY_RECORD 流程）
 * - add_shopping_item: 采购物品（手动/AI 共用）
 * - complete_purchase: 采购完成（清单里的东西到手 → 入厨房确认）
 * - add_consumable   : 消耗品录入 + 自动生成 Reminder
 *
 * 类型占位、暂不实现任务：
 * - add_reminder        : 普通提醒事项（保留扩展位）
 * - create_life_record  : 生活记录（保留扩展位）
 */

import type { InventoryIngredient } from '@/lib/types/ingredient';
import type { ConsumableItem } from '@/lib/types/consumable';
import type { ShoppingList, ShoppingListItem } from '@/lib/types/shopping-list';

export type AITaskType =
  | 'chat'
  | 'add_inventory'
  | 'add_shopping_item'
  | 'complete_purchase'
  | 'add_consumable'
  | 'update_consumable_status'
  | 'update_consumable_check_interval'
  | 'add_reminder'
  | 'create_life_record';

/**
 * AI Task 识别结果（来自 router）。
 *
 * - taskType: 选中的任务
 * - confidence: 0~1，由 router 给出
 * - reason: 路由理由（用于日志 / 调试）
 */
export interface AITaskIntent {
  taskType: AITaskType;
  confidence: number;
  reason: string;
}

/**
 * 单条采购物品草稿（AI 提取）。
 *
 * 必填：name
 * 推荐：quantity / unit / neededBy
 * 可选：budget / remindAt / notes
 */
export interface ShoppingItemDraft {
  name: string;
  quantity?: number;
  unit?: string;
  budget?: number;
  neededBy?: string;
  remindAt?: string;
  notes?: string;
}

/**
 * 单条食材录入草稿（AI 提取）。
 *
 * 必填：name
 * 推荐：quantity / unit
 * 可选：category / purchaseDate / expiryDate / storageLocation
 */
export interface InventoryItemDraft {
  name: string;
  quantity?: number | string;
  unit?: string;
  category?: string;
  purchaseDate?: string;
  expiryDate?: string;
  storageLocation?: string;
  price?: number;
}

/**
 * 采购完成 → 待入厨房的一条：购物清单条目本体 + 它所属的清单 id。
 *
 * 现实数据形状不在这里重新发明，直接沿用 ShoppingListItem；
 * 入库草稿由 record.ts 的 shoppingItemToRestockDraft 统一生成。
 * listId + itemId 是回写 purchased / restockedAt 的锚点。
 */
export interface RestockItemDraft extends ShoppingListItem {
  listId: string;
}

/**
 * 单条消耗品草稿（AI 多轮提取）。
 *
 * 必填：name
 * 推荐：quantity / unit / location
 * 使用情况（二选一）：
 *   - estimatedRunOutDays：用户知道大概多久用完
 *   - checkIntervalDays：用户不知道，多久询问一次
 *
 * missingFields：可选 UI 提示，AI 多轮对话时使用。
 */
export interface ConsumableDraft {
  name: string;
  quantity?: number | string;
  unit?: string;
  location?: string;
  estimatedRunOutDays?: number;
  checkIntervalDays?: number;
  status?: 'collecting' | 'ready';
  missingFields?: ('location' | 'run_out_estimate' | 'check_interval')[];
}

export type ConsumableMissingField =
  | 'location'
  | 'run_out_estimate'
  | 'check_interval';

/**
 * 消耗品状态更新的紧迫度（由用户表述 + 余量推导）。
 * - urgent：已用完 / 余量为 0 → 立即补货
 * - soon：快用完 / 余量 ≤ 1 → 建议尽快补货
 * - normal：仅更新余量
 */
export type ConsumableUrgency = 'urgent' | 'soon' | 'normal';

/**
 * 单条消耗品状态更新（AI 从「纸巾用完了 / 洗衣液还剩两瓶」提取）。
 *
 * 与 ConsumableDraft 的区别：这里不是新物品，而是对已存在 ConsumableItem
 * 的余量 / 状态回写，因此必须携带 consumableId。
 */
export interface ConsumableStatusUpdate {
  consumableId: string;
  name: string;
  /** 用户报告的剩余数量；used_up 时隐含 0 */
  remainingQuantity?: number;
  /** 用户报告的「还能用 N 天」——语义是耗尽倒计时，不是剩余数量 */
  estimatedRunOutDays?: number;
  urgency: ConsumableUrgency;
  /** 是否把 status 置为 finished */
  markFinished: boolean;
  /** 计量单位：补货派生采购草稿时沿用，避免「1」变成无名无姓的数字 */
  unit?: string;
  /** 展示给用户的说明，例如「剩余 2 瓶」 */
  summary: string;
}

/**
 * 不同任务对应的"已提取草稿"。
 * 不存在草稿（chat）时为 null。
 */
export interface AITaskDrafts {
  chat: null;
  add_inventory: {
    items: InventoryItemDraft[];
  };
  add_shopping_item: {
    items: ShoppingItemDraft[];
  };
  complete_purchase: {
    items: RestockItemDraft[];
  };
  add_consumable: {
    items: ConsumableDraft[];
  };
  update_consumable_status: {
    updates: ConsumableStatusUpdate[];
  };
  update_consumable_check_interval: {
    items: ConsumableDraft[];
  };
  add_reminder: null;
  create_life_record: null;
}

/**
 * add_consumable 多轮收集的当前阶段：
 * - collecting：仍在问「放在哪里 / 多久用完」，不展示确认卡片
 * - confirming：字段已收齐，前端展示确认卡片
 */
export type ConsumableSessionPhase = 'collecting' | 'confirming';

/**
 * 任务抽取结果。
 *
 * router.run() 返回：
 * - intent: 路由决定
 * - drafts: 对应任务类型的提取草稿（可能为空数组，例如用户说了"帮我买纸巾"但没说数量）
 * - replyText: AI 给用户的自然语言回复（用于 assistant message.content）
 * - requiresConfirmation: 是否需要用户确认才落地（默认 true）
 */
/**
 * 进行中的多轮 Task 快照。
 *
 * 定义在 types 层：task-router 需要在选任务之前就知道有没有进行中的会话，
 * 而 router 不能反向依赖 active-task（会成环）。
 */
export interface ActiveTaskSnapshot {
  taskType: string;
  consumableDrafts?: ConsumableDraft[];
  consumablePhase?: ConsumableSessionPhase;
  shoppingDrafts?: ShoppingItemDraft[];
}

export interface AITaskExtraction {
  intent: AITaskIntent;
  drafts: AITaskDrafts[AITaskType];
  replyText: string;
  requiresConfirmation: boolean;
  /**
   * 仅 add_consumable：多轮收集阶段。
   * collecting 时前端不展示确认卡片，confirming 时展示。
   */
  consumablePhase?: ConsumableSessionPhase;
  /**
   * 仅 update_consumable_status：已确定的状态回写指令。
   * requiresConfirmation = false，前端应用后直接写 Reality Storage。
   */
  consumableUpdates?: ConsumableStatusUpdate[];
  /**
   * Router 内部信号：这句话被归给一个进行中的会话，字段还没绑定。
   * route 层据此调用 continue*Task；不会下发给前端。
   */
  continuation?: boolean;
  /**
   * 卡片等待点头时，用户直接打字说了「确认 / 算了」。
   *
   * 这不是新任务，而是对已有卡片的一次点击：route 层据此下发 cardCommand，
   * 前端用与按钮完全相同的 commit 函数落地，并把卡片翻到结果态。
   */
  cardCommand?: CardCommand;
  /**
   * 仅 update_consumable_status：由「已用完 / 快用完了」派生出的采购草稿。
   * 它让补货直接复用 add_shopping_item 的确认卡片与续采会话，而不是再造一张卡。
   */
  shoppingDrafts?: ShoppingItemDraft[];
}

/**
 * 卡片口令：等价于用户在确认卡片上点了那个按钮。
 */
export type CardCommand = 'confirm' | 'cancel';

/** 口令作用在哪种卡片上 */
export type CardKind = 'consumable' | 'shopping';

/**
 * 任务执行上下文：调用方提供给 task 模块的只读快照。
 */
export interface AITaskContext {
  message: string;
  ingredients?: InventoryIngredient[];
  hasActiveInventoryDraft?: boolean;
  /** 已有消耗品快照：update_consumable_status 需要按名字匹配到具体条目 */
  consumables?: ConsumableItem[];
  /**
   * 进行中的多轮 Task 快照（前端回传，服务端无状态）。
   * Router 在「选任务」之前就要知道有没有进行中的会话，因此放在 context 层。
   */
  activeTask?: ActiveTaskSnapshot;
  /**
   * 购物清单快照（前端回传）。采购完成要靠它判断「用户点名的东西确实还在清单上」，
   * 对不上就不抢普通录入的路，绝不凭一句话凭空造入库卡。
   */
  shoppingLists?: ShoppingList[];
}