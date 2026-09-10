/**
 * AI Provider 统一接口定义
 * 
 * 现在：Data Source = localStorage
 * 未来：Data Source = Qingshe Database
 * AI Provider 永远不直接访问 Data Source
 */

export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AIChatRequest {
  messages: AIMessage[];
  temperature?: number;
  maxTokens?: number;
  model?: string;
}

export interface AIChatResponse {
  content: string;
}

export interface AIProvider {
  chat(request: AIChatRequest): Promise<AIChatResponse>;
}