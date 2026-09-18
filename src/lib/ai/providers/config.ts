/**
 * AI Provider 配置状态探针
 *
 * 只读、同步、无副作用：不构造 Provider 实例、不发网络请求。
 *
 * 为什么需要它：getAIProvider() 是实例工厂，构造函数在缺 key/model 时直接
 * throw，调用方只能 try/catch，而且「缺 key」「缺 model」「provider 不支持」
 * 三种情况被混成一个错误，业务层没法区分也没法给用户准确提示。
 * 业务层（route / intent / record）应通过本模块判断 AI 是否可用，
 * 而不是各自去读 AMD_AI_* 环境变量。
 */

export interface AIConfigStatus {
  provider: string;
  configured: boolean;
  /** 人类可读的缺失项名称（如「API Key」），绝不包含环境变量名或密钥值 */
  missing: string[];
  reason?: string;
}

const DEFAULT_PROVIDER = 'amd';

/** 当前支持的 provider，缺省值之外的其他值一律视为未支持 */
const SUPPORTED_PROVIDERS = new Set<string>(['amd']);

/**
 * amd 必备配置项：name 是环境变量键（只在进程内读取，不进返回值），
 * label 是人类可读名称（会出现在 missing / reason 里）。
 */
const AMD_REQUIRED_VARS: ReadonlyArray<{ name: string; label: string }> = [
  { name: 'AMD_AI_API_KEY', label: 'API Key' },
  { name: 'AMD_AI_MODEL', label: '模型名' }
];

/** 当前生效的 provider 名（小写归一）；AI_PROVIDER 未设置时缺省 amd */
export function getAIProviderName(): string {
  return (process.env.AI_PROVIDER || DEFAULT_PROVIDER).toLowerCase();
}

/**
 * 探测当前 AI 配置状态：
 * - provider 不支持 → configured:false，missing 为空，reason 说明原因
 * - provider 支持但缺配置项 → configured:false，missing 列出缺失项
 * - 齐全 → configured:true，无 missing / reason
 */
export function getAIConfigStatus(): AIConfigStatus {
  const provider = getAIProviderName();

  if (!SUPPORTED_PROVIDERS.has(provider)) {
    return {
      provider,
      configured: false,
      missing: [],
      reason: `不支持的 AI Provider「${provider}」，当前仅支持 amd`
    };
  }

  const missing = AMD_REQUIRED_VARS.filter((v) => !process.env[v.name]).map((v) => v.label);

  return {
    provider,
    configured: missing.length === 0,
    missing,
    reason: missing.length === 0 ? undefined : `缺少配置：${missing.join('、')}`
  };
}

export function isAIConfigured(): boolean {
  return getAIConfigStatus().configured;
}