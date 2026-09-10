import {
  isShoppingFieldOnlyMessage,
  extractShoppingItems,
  mergeShoppingDrafts,
  applyShoppingFieldReply
} from '../src/lib/ai/tasks/shopping-task';
import { continueShoppingTask } from '../src/lib/ai/tasks/active-task';
import type { ShoppingItemDraft } from '../src/lib/ai/tasks/types';

const existing: ShoppingItemDraft[] = [{ name: '面巾纸', quantity: 1, unit: '包' }];
const activeTask = { taskType: 'add_shopping_item', shoppingDrafts: existing } as never;

const PHRASES = [
  // A 类：纯字段补充
  '明天买', '后天买', '下周买', '预算20', '预算20块', '20元以内',
  '告诉我明天买', '告诉我后天买', '预算控制在30', '告诉我明天买，预算20',
  '那就明天买', '帮我预算20', '计划下周',
  // A2 类：口语包装 + 真实商品（包装语必须剥掉，商品要留下）
  '告诉我明天买纸巾', '提醒我后天买洗衣液', '通知我周末买鸡蛋',
  '告诉我大后天买垃圾袋', '提醒我买两包面巾纸',
  // B 类：明确新增
  '再加牙膏', '还要买洗衣液', '顺便买鸡蛋', '新增垃圾袋', '再买一包纸巾',
  // 混合
  '预算20元，明天买', '再加牙膏，预算20'
];

const fmt = (ds: ShoppingItemDraft[]) =>
  ds.map((d) => `${d.name}×${d.quantity ?? '-'}${d.unit ?? ''}${d.neededBy ? '/' + d.neededBy : ''}${d.budget != null ? '/¥' + d.budget : ''}`);

console.log('phrase'.padEnd(22), '| fieldOnly | parser | continuation');
for (const p of PHRASES) {
  const fo = isShoppingFieldOnlyMessage(p);
  const parsed = fmt(extractShoppingItems(p));
  const cont = continueShoppingTask(activeTask, { message: p, ingredients: [], consumables: [] } as never);
  const items = ((cont.drafts as { items?: ShoppingItemDraft[] }).items ?? []);
  console.log(
    p.padEnd(22), '|', String(fo).padEnd(9), '|',
    JSON.stringify(parsed).padEnd(34), '|',
    JSON.stringify(fmt(items)), cont.intent.reason.includes('补充') ? '' : '(' + cont.intent.reason + ')'
  );
}
console.log('\nmerge 行为:', JSON.stringify(fmt(mergeShoppingDrafts(existing, [{ name: '加牙膏' }]))));