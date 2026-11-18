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

export type TaskState = 'queued' | 'running' | 'waiting_confirmation' | 'cancelling'
  | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export interface TaskRecord {
  id: string; conversation_id: string | null; project_id: string; project_root: string;
  goal: string; agent_id: string; current_step?: string | null; status: TaskState; result: string | null; reason: string | null;
  event_seq: number; created_at: string; updated_at: string; timeout_seconds: number;
}
export interface TaskProject { id: string; name: string; root: string }
export interface TaskPlugin {
  manifest: { id: string; name: string; agents: { id: string; name: string; executor_id: string }[] };
  enabled: boolean;
  executor: { id: string; version: string; ready: boolean; code: string; message: string;
    limitations: string[]; model_selection?: { provider: string; model: string; reasoningEffort?: string } };
}
export interface TaskEvent {
  task_id: string; attempt_id: string | null; seq: number; type: string;
  occurred_at: string; payload: Record<string, unknown>;
}
export interface TaskDetail {
  task: TaskRecord;
  attempts: { id: string; number: number; executor_id: string; executor_version: string;
    run_ref: string | null; status: TaskState; exit_code: number | null; reason: string | null }[];
  artifacts: { id: string; path: string; kind: string; sha256: string | null }[];
}
export interface TaskSubmission {
  conversation_id: string; project_id: string; goal: string; idempotency_key: string;
  agent_id?: string; timeout_seconds?: number;
}
