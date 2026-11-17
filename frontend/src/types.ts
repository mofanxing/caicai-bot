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
  channel: 'debug' | 'desktop' | 'wechat_personal';
  account_id: string;
  peer_id: string;
  provider_id: string | null;
  model_id: string | null;
  reply_mode: 'text' | 'voice' | 'both';
  voice_id: string | null;
  voice_prompt: string;
  feedback_enabled?: boolean;
  feedback_thinking_text?: string;
  feedback_waiting_text?: string;
  feedback_thinking_job_id?: string | null;
  feedback_waiting_job_id?: string | null;
  system_prompt: string;
}

export type ConversationSettings = Pick<Conversation,
  'provider_id' | 'model_id' | 'reply_mode' | 'voice_id' | 'voice_prompt' | 'system_prompt' | 'feedback_enabled' | 'feedback_thinking_text' | 'feedback_waiting_text'>;

export interface ChatMessage {
  id: string;
  external_id: string;
  user_text: string;
  assistant_text: string | null;
  status: 'processing' | 'completed' | 'sending' | 'sent' | 'failed' | 'delivery_unknown';
  speech_job_id: string | null;
  speech_job_ids?: string[];
}

export type ChatStreamEvent =
  | { type: 'start'; message_id: string }
  | { type: 'delta'; text: string }
  | { type: 'speech'; job_id: string }
  | { type: 'notice'; message: string }
  | { type: 'error'; message: string; code?: string }
  | { type: 'done'; message: ChatMessage };

export interface VoiceProfile {
  id: string; name: string; reference_text: string; style_prompt: string;
  duration_seconds: number; created_at: string;
}

export interface SpeechStatus {
  engine: string; model: string; state: string; detail: string;
  available: boolean; supports_style_prompt: boolean; local_only: boolean;
}

export interface SpeechJob {
  id: string; voice_id: string; message_id: string | null; text: string; style_prompt: string;
  status: 'queued' | 'running' | 'completed' | 'failed'; error: string | null;
  duration_seconds: number | null; generation_seconds: number | null; created_at: string;
}

export interface SpeechFeedback {
  voice_id: string; style_prompt: string; thinking: SpeechJob | null; waiting: SpeechJob | null;
}

export interface Capabilities {
  llm: string[];
  debug_mock_enabled: boolean;
  wechat_personal: string;
  tts: string;
  asr: string;
}
