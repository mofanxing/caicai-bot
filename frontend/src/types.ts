export interface Provider {
  id: string;
  name: string;
  base_url: string;
  api_key_env: string;
  has_api_key: boolean;
  key_source: 'encrypted' | 'environment' | 'missing';
}

export interface ProviderCreate {
  name: string;
  base_url: string;
  api_key: string;
}

export interface Conversation {
  id: string;
  channel: 'debug' | 'wechat_personal';
  account_id: string;
  peer_id: string;
  provider_id: string | null;
  model_id: string | null;
  reply_mode: 'text' | 'voice' | 'both';
  voice_id: string | null;
  system_prompt: string;
}

export type ConversationSettings = Pick<Conversation,
  'provider_id' | 'model_id' | 'reply_mode' | 'voice_id' | 'system_prompt'>;

export interface ChatMessage {
  id: string;
  external_id: string;
  user_text: string;
  assistant_text: string | null;
  status: 'processing' | 'completed' | 'sending' | 'sent' | 'failed' | 'delivery_unknown';
}

export interface Capabilities {
  llm: string[];
  debug_mock_enabled: boolean;
  wechat_personal: string;
  tts: string;
  asr: string;
}
