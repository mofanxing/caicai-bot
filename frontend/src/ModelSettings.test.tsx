import { useState } from 'react';
import { App as AntApp } from 'antd';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelSettings } from './App';
import type { Api } from './api';
import type { Capabilities, Conversation, SpeechFeedback, VoiceProfile } from './types';

const conversation: Conversation = { id: 'c1', channel: 'desktop', account_id: 'desktop', peer_id: '大肥鱼',
  provider_id: null, model_id: null, reply_mode: 'both', voice_id: 'v1', voice_prompt: '轻快', system_prompt: '友善',
  feedback_enabled: true, feedback_thinking_text: '让我想想。', feedback_waiting_text: '声音马上好。',
  feedback_thinking_job_id: null, feedback_waiting_job_id: null };
const empty: SpeechFeedback = { voice_id: 'v1', style_prompt: '轻快', thinking: null, waiting: null };
const ready = { ...empty, thinking: { id: 't1', status: 'completed' }, waiting: { id: 'w1', status: 'completed' } } as SpeechFeedback;
let api: Api;
let onGeneration: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  api = { feedback: vi.fn().mockResolvedValue(empty),
    settings: vi.fn(async (_id, values) => ({ ...conversation, ...values })),
    generateFeedback: vi.fn().mockResolvedValue(ready),
  } as unknown as Api;
  onGeneration = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup() {
  function Harness() {
    const [current, setCurrent] = useState(conversation);
    return <AntApp><ModelSettings api={api} conversation={current} providers={[]} voices={[
      { id: 'v1', name: '当前音色' } as VoiceProfile,
    ]} capabilities={{ debug_mock_enabled: true } as Capabilities} onSaved={setCurrent}
      onFeedbackGeneration={onGeneration} disabled={false} /></AntApp>;
  }
  render(<Harness />);
}

describe('manual waiting voice settings', () => {
  it('edits and saves per-conversation text and switch without generating audio', async () => {
    setup();
    await screen.findByText(/当前配置尚未生成提示语音/);
    expect((screen.getByRole('textbox', { name: '思考提示语' }) as HTMLTextAreaElement).value).toBe('让我想想。');
    fireEvent.change(screen.getByRole('textbox', { name: '思考提示语' }), { target: { value: '大肥鱼想一想。' } });
    fireEvent.change(screen.getByRole('textbox', { name: '语音合成等待提示语' }), { target: { value: '等我准备好声音。' } });
    fireEvent.click(screen.getByRole('switch', { name: '等待时语音回应' }));
    fireEvent.click(screen.getByRole('button', { name: '保存聊天设置' }));
    await waitFor(() => expect(api.settings).toHaveBeenCalledWith('c1', expect.objectContaining({
      feedback_enabled: false, feedback_thinking_text: '大肥鱼想一想。', feedback_waiting_text: '等我准备好声音。',
    })));
    expect(api.generateFeedback).not.toHaveBeenCalled();
  });

  it('saves current fields before manual generation and installs the new audio ids', async () => {
    vi.mocked(api.feedback).mockImplementation(async () => vi.mocked(api.generateFeedback).mock.calls.length ? ready : empty);
    let release!: (value: SpeechFeedback) => void;
    vi.mocked(api.generateFeedback).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    setup();
    fireEvent.change(screen.getByRole('textbox', { name: '思考提示语' }), { target: { value: '我来想想办法。' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并生成提示语音' }));
    await waitFor(() => expect(api.generateFeedback).toHaveBeenCalledWith('c1'));
    expect(api.settings).toHaveBeenCalledWith('c1', expect.objectContaining({ feedback_thinking_text: '我来想想办法。' }));
    expect(vi.mocked(api.settings).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.generateFeedback).mock.invocationCallOrder[0]);
    expect(onGeneration).toHaveBeenCalledWith('c1', true);
    await act(async () => release(ready));
    await screen.findByText('当前配置的提示语音已生成。');
    expect(onGeneration).toHaveBeenLastCalledWith('c1', false);
    fireEvent.click(screen.getByRole('button', { name: '保存聊天设置' }));
    await waitFor(() => expect(api.settings).toHaveBeenCalledTimes(2));
    expect(api.generateFeedback).toHaveBeenCalledTimes(1);
  });

  it('shows generation failure and lets the user explicitly generate again', async () => {
    const failed = { ...ready, thinking: { ...ready.thinking, status: 'failed' } } as SpeechFeedback;
    vi.mocked(api.feedback).mockResolvedValue(failed);
    setup();
    await screen.findByText('提示语音生成失败，请重新生成。');
    expect(api.generateFeedback).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '保存并生成提示语音' }));
    await waitFor(() => expect(api.generateFeedback).toHaveBeenCalledTimes(1));
  });
});
