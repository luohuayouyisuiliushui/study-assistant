import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import QAPanel from '../components/QAPanel.jsx';

class MockSpeechRecognition {
  static instances = [];

  constructor() {
    this.start = vi.fn();
    this.stop = vi.fn();
    this.abort = vi.fn();
    MockSpeechRecognition.instances.push(this);
  }
}

const renderPanel = () => render(
  <QAPanel qaList={[]} onAsk={vi.fn()} loading={false} scrollToRound={vi.fn()} setHoveredRound={vi.fn()} hoveredRound={null} />,
);

afterEach(() => {
  MockSpeechRecognition.instances = [];
  window.SpeechRecognition = undefined;
  window.webkitSpeechRecognition = undefined;
});

describe('QAPanel', () => {
  it('adds speech recognition text to the existing question', () => {
    window.SpeechRecognition = MockSpeechRecognition;
    renderPanel();

    const input = screen.getByPlaceholderText('输入你的追问...（Shift+Enter 换行，Enter 发送）');
    fireEvent.change(input, { target: { value: '请解释' } });
    fireEvent.click(screen.getByRole('button', { name: '开始语音输入' }));

    const recognition = MockSpeechRecognition.instances[0];
    expect(recognition.lang).toBe('zh-CN');
    expect(recognition.interimResults).toBe(true);
    expect(recognition.start).toHaveBeenCalledOnce();

    act(() => {
      recognition.onresult({ results: [{ 0: { transcript: '量子纠缠' }, isFinal: true }] });
    });
    expect(input).toHaveValue('请解释 量子纠缠');
  });

  it('stops a recording when the microphone button is clicked again', () => {
    window.SpeechRecognition = MockSpeechRecognition;
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: '开始语音输入' }));
    const recognition = MockSpeechRecognition.instances[0];
    fireEvent.click(screen.getByRole('button', { name: '停止语音输入' }));

    expect(recognition.stop).toHaveBeenCalledOnce();
  });

  it('does not render a microphone control without browser support', () => {
    renderPanel();

    expect(screen.queryByRole('button', { name: '开始语音输入' })).toBeNull();
  });

  it('shows a recoverable permission error', () => {
    window.SpeechRecognition = MockSpeechRecognition;
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '开始语音输入' }));

    act(() => {
      MockSpeechRecognition.instances[0].onerror({ error: 'not-allowed' });
    });
    expect(screen.getByRole('alert')).toHaveTextContent('请允许浏览器使用麦克风后重试。');
  });
});
