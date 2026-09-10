import { routeAITask } from '@/lib/ai/tasks';

const cases = [
  '番茄',
  '今天买了三斤番茄',
  '明天帮我买包纸巾',
  '今天买了洗衣液和垃圾袋，都放阳台'
];

for (const message of cases) {
  const r = routeAITask({ message, ingredients: [], consumables: [] });
  process.stdout.write(
    `${message} -> ${r.intent.taskType} | ${r.intent.reason} | ${r.replyText.replace(/\n/g, ' ⏎ ')}\n`
  );
}