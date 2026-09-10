/**
 * 确认结果类型
 */
export type ConfirmationResult = 'confirmed' | 'rejected' | 'unclear';

/**
 * 判断用户消息是否表示确认
 * 支持中文表达如："对"、"是"、"没错"、"确认"、"可以"、"正确"、"嗯"、"好的"、"好"
 * 以及其他肯定表达
 */
export function parseConfirmation(message: string): ConfirmationResult {
  // 清理消息，去除空白字符并转为小写
  const cleanMessage = message.trim();
  
  // 肯定确认的关键词
  const positiveKeywords = [
    '对', '是', '没错', '确认', '可以', '正确', 
    '嗯', '好的', '好', '行', 'ok', 'yes',
    '同意', '接受', '认可', '确定', '对的',
    '就是这样', '没错的', '是的', '对啊', '嗯嗯'
  ];
  
  // 否定确认的关键词
  const negativeKeywords = [
    '不对', '不是', '改一下', '错', '否', '不',
    '不行', '不要', '错了', '不是的', '不对的',
    'no', 'cancel', '取消', '拒绝', '否认',
    '再想想', '不对劲', '有问题', '重新', '修改'
  ];
  
  // 检查是否包含否定关键词
  for (const keyword of negativeKeywords) {
    if (cleanMessage.includes(keyword)) {
      return 'rejected';
    }
  }
  
  // 检查是否包含肯定关键词
  for (const keyword of positiveKeywords) {
    if (cleanMessage.includes(keyword)) {
      return 'confirmed';
    }
  }
  
  // 检查模糊表达
  const unclearKeywords = [
    '什么', '什么的', '再说', '考虑', '也许', '可能',
    '大概', '好像', '不太', '有点', '待定', '不确定',
    '不清楚', '疑惑', '疑问', '怎么办', '如何',
    'maybe', 'perhaps', 'unsure', 'uncertain'
  ];
  
  for (const keyword of unclearKeywords) {
    if (cleanMessage.includes(keyword)) {
      return 'unclear';
    }
  }
  
  // 如果消息很短且是单个肯定词，倾向于确认
  if (cleanMessage.length <= 2) {
    if (positiveKeywords.some(kw => cleanMessage.includes(kw))) {
      return 'confirmed';
    }
    if (negativeKeywords.some(kw => cleanMessage.includes(kw))) {
      return 'rejected';
    }
  }
  
  // 默认返回unclear
  return 'unclear';
}

/**
 * 检查消息是否包含确认意图
 */
export function isConfirmationIntent(message: string): boolean {
  return parseConfirmation(message) !== 'unclear';
}

/**
 * 卡片口令：整句话只由「确认 / 取消」词构成时，等价于点了卡片上的按钮。
 *
 * 为什么不用 parseConfirmation：它是子串匹配，「好的放储物室」也会被读成确认。
 * 卡片口令必须整句锚定，否则用户在补字段时会被误判成一次点击。
 */
const CARD_CONFIRM_WORDS = new Set([
  '确认', '确定', '确认记录', '确认加入', '确认添加',
  '对', '对的', '是', '是的', '没错',
  '好', '好的', '行', '可以', '没问题', '同意',
  '加', '加吧', '加入', '加进去', '加到清单', '放进清单', '要', '需要',
  'ok', 'okay', 'yes', 'y', 'confirm'
]);

const CARD_CANCEL_WORDS = new Set(
  [
    '取消', '算了', '不用', '不要', '先不', '先不用', '不加入',
    '不加', '不要了', '错', '不对', 'no', 'cancel',
    // 扩展否定口令：「不买了 / 别买了 / 不记了」这类以「了」结尾的表达会被
    // normalizeCardCommand 剥掉语气词，所以登记词干即可。
    '不买', '别买', '不记', '别记', '不录', '清空', '撤掉', '作废',
    '删除', '删掉', '移除', '放弃'
  ].map(normalizeCardCommand)
);

/** 去掉标点、空白和句尾语气词，留下真正的指令词 */
export function normalizeCardCommand(message: string): string {
  return message
    .trim()
    .toLowerCase()
    .replace(/[\s。，、,.!！?？~～:：;；"'“”‘’]/g, '')
    .replace(/(吧|呀|啊|哦|噢|哈|啦|呗|了|谢谢|谢了)+$/g, '');
}

export function readCardCommand(message: string): 'confirm' | 'cancel' | null {
  const normalized = normalizeCardCommand(message);
  if (!normalized) return null;
  if (CARD_CANCEL_WORDS.has(normalized)) return 'cancel';
  if (CARD_CONFIRM_WORDS.has(normalized)) return 'confirm';
  return null;
}

/**
 * 食材录入草稿的「作废」口令。
 *
 * 为什么不能复用 parseConfirmation：它把「取消」和「改一下」都归为 rejected，
 * 而这两件事在产品上完全相反 —— 丢弃这条记录 vs 继续编辑这条记录。
 * 沿用 rejected 会让一句「取消」掉进 extractIngredientRecord，白白打一次 LLM，
 * 离线时直接报错，草稿还留在原地。
 *
 * 区分靠的是整句锚定，不是黑名单：全句只剩一个丢弃词才算作废。
 * 「不要了，改成3个」「数量错了」这类带内容的表达天然落不进这个集合，
 * 会自动回到原有的编辑/补字段流程 —— 不需要额外的「修改意图」正则，
 * 加了也永远命中不到（集合里的词没有一个含「改」）。
 *
 * 词表与消息都过一遍 normalizeCardCommand：否则「算了」会被剥成「算」而落空。
 */
const INGREDIENT_DISCARD_WORDS = new Set(
  [
    '取消', '作废', '不要了', '算了', '不添加了', '不加了', '别加了',
    '别录了', '不录了', '删掉', '删除', '放弃', 'cancel', 'discard'
  ].map(normalizeCardCommand)
);

export function isIngredientDraftDiscard(message: string): boolean {
  const normalized = normalizeCardCommand(message);
  if (!normalized) return false;
  return INGREDIENT_DISCARD_WORDS.has(normalized);
}