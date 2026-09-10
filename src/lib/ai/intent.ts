import { NextRequest } from 'next/server';
import { chatWithAI } from './service';

export type QingsheIntent =
  | "REALITY_RECORD"
  | "REALITY_QUERY"
  | "LIFE_SOLUTION"
  | "EMOTIONAL_REDIRECT"
  | "UNSUPPORTED";

export type RealityDataType =
  | "ingredients"
  | "home_items"
  | "consumables"
  | "favorite_places"
  | "reminders"
  | "preferences"
  | "family_members";

export interface IntentResult {
  intent: QingsheIntent;
  confidence: number;
  reason: string;
  requiredData: RealityDataType[];
}

export async function classifyIntent(message: string): Promise<IntentResult> {
  const apiKey = process.env.AMD_AI_API_KEY;
  const model = process.env.AMD_AI_MODEL;

  if (!apiKey || !model) {
    return {
      intent: "LIFE_SOLUTION",
      confidence: 0,
      reason: "Intent classification fallback due to missing API configuration",
      requiredData: []
    };
  }

  const systemPrompt = `你是轻舍 Qingshe 的意图分类器。
你的任务不是回答用户问题，而是判断用户输入属于哪一种 Intent，并确定需要哪些真实数据来回答用户问题。
只能从 REALITY_RECORD、REALITY_QUERY、LIFE_SOLUTION、EMOTIONAL_REDIRECT、UNSUPPORTED 中选择一个。
对于需要真实数据的情况，指定所需数据类型。当前可用数据类型包括：ingredients（冰箱食材）、home_items（家中物品）、consumables（消耗品）、favorite_places（常去地点）、reminders（提醒事项）、preferences（偏好设置）、family_members（家庭成员）。
必须返回严格 JSON，不要 Markdown，不要解释文字。

分类标准：
REALITY_RECORD：用户告诉轻舍现实生活发生了什么，需要记录数据。如：\"我今天买了一盒牛奶放冰箱\"、\"下个月提醒我换滤芯\"、\"我今天在一家饭店吃饭很好吃\"
REALITY_QUERY：用户询问与自己真实生活数据有关的问题。如：\"我今晚吃什么\"、\"我冰箱里的东西能做什么\"、\"家里还有洗衣液吗\"
LIFE_SOLUTION：用户询问普通现实生活解决方案。如：\"我想买床垫预算2000\"、\"出租屋怎么除湿\"、\"洗衣机有异味怎么办\"
EMOTIONAL_REDIRECT：用户表达焦虑、烦躁、低落等日常情绪，希望轻舍进行生活化回应并引导回现实行动。如：\"最近好焦虑\"、\"今天好烦\"、\"感觉很累\"
UNSUPPORTED：与轻舍现实生活助手定位无关的问题。如：\"帮我写Python代码\"、\"分析股票\"、\"写论文\"

返回格式：
{
  "intent": "REALITY_QUERY",
  "confidence": 0.95,
  "reason": "用户正在询问基于现有食材的生活问题",
  "requiredData": ["ingredients"]
}`;

  try {
    const aiResponse = await chatWithAI({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ],
      temperature: 0.1,
      maxTokens: 256
    });

    let content = aiResponse;

    try {
      // Attempt to parse the JSON response from the model
      const result = JSON.parse(content.trim());
      
      if (isValidIntentResult(result)) {
        return result;
      } else {
        console.error('Invalid intent result format:', result);
        return {
          intent: "LIFE_SOLUTION",
          confidence: 0,
          reason: "Intent classification fallback due to invalid result format",
          requiredData: []
        };
      }
    } catch (jsonError) {
      // If the content itself is not JSON, try to extract JSON from it
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const extractedJson = JSON.parse(jsonMatch[0]);
          if (isValidIntentResult(extractedJson)) {
            return extractedJson;
          }
        } catch (extractError) {
          console.error('Failed to extract JSON from intent response:', content);
        }
      }
      
      console.error('Failed to parse intent response as JSON:', content);
      return {
        intent: "LIFE_SOLUTION",
        confidence: 0,
        reason: "Intent classification fallback due to JSON parsing error",
        requiredData: []
      };
    }
  } catch (error) {
    console.error('Error in classifyIntent:', {
      errorInfo: error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
            cause: (error as any).cause,
          }
        : {
            message: String(error),
          }
    });

    return {
      intent: "LIFE_SOLUTION",
      confidence: 0,
      reason: "Intent classification fallback due to network error",
      requiredData: []
    };
  }
}

function isValidIntentResult(result: any): result is IntentResult {
  return (
    typeof result === 'object' &&
    result !== null &&
    ['REALITY_RECORD', 'REALITY_QUERY', 'LIFE_SOLUTION', 'EMOTIONAL_REDIRECT', 'UNSUPPORTED'].includes(result.intent) &&
    typeof result.confidence === 'number' &&
    typeof result.reason === 'string' &&
    Array.isArray(result.requiredData) &&
    result.requiredData.every((data: any) => 
      ['ingredients', 'home_items', 'consumables', 'favorite_places', 'reminders', 'preferences', 'family_members'].includes(data)
    )
  );
}