import type { AIChatRequest } from './providers/types';
import { getAIProvider } from './providers';

/**
 * 统一 AI Service
 * 
 * 现在：Data Source = localStorage
 * 未来：Data Source = Qingshe Database
 * AI Provider 永远不直接访问 Data Source
 */
export async function chatWithAI(request: AIChatRequest): Promise<string> {
  const provider = getAIProvider();
  const response = await provider.chat(request);
  return response.content;
}