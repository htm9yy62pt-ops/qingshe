import type { AIChatRequest, AIChatResponse, AIProvider } from './types';

/**
 * AMD AI Provider 实现
 * 
 * 现在：Data Source = localStorage
 * 未来：Data Source = Qingshe Database
 * AI Provider 永远不直接访问 Data Source
 */
export class AMDProvider implements AIProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor() {
    const apiKey = process.env.AMD_AI_API_KEY;
    const model = process.env.AMD_AI_MODEL;
    const baseUrl = process.env.AMD_AI_BASE_URL || 'https://developer.amd.com.cn/radeon/api/v1';

    if (!apiKey) {
      throw new Error('Missing AMD AI API key configuration');
    }

    if (!model) {
      throw new Error('Missing AMD AI model configuration');
    }

    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
  }

  async chat(request: AIChatRequest): Promise<AIChatResponse> {
    const { messages, temperature = 0.1, maxTokens = 512, model = this.model } = request;

    const requestBody = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens
    };

    try {
      const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody)
      });

      const responseStatus = response.status;
      const responseStatusText = response.statusText;
      const responseText = await response.text();

      if (!response.ok) {
        console.error('AMD API Status:', responseStatus);
        console.error('AMD API StatusText:', responseStatusText);
        console.error('AMD API Response Body:', responseText);
        
        throw new Error(`AMD API request failed with status ${responseStatus}: ${responseStatusText}`);
      }

      let data;
      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        console.error('Failed to parse AMD response:', responseText);
        throw new Error('Invalid response format from AMD service');
      }

      const content = data.choices?.[0]?.message?.content;

      if (!content) {
        console.error('AMD response missing content:', responseText);
        throw new Error('No content from AMD service');
      }

      return { content };
    } catch (error) {
      console.error('Error in AMDProvider:', {
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

      throw error;
    }
  }
}