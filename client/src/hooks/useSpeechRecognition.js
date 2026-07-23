import { useCallback, useEffect, useRef, useState } from 'react';

function getSpeechRecognition() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function appendTranscript(value, transcript) {
  const spoken = transcript.trim();
  if (!spoken) return value;
  const existing = value.trimEnd();
  return existing ? `${existing} ${spoken}` : spoken;
}

const ERROR_MESSAGES = {
  'not-allowed': '请允许浏览器使用麦克风后重试。',
  'service-not-allowed': '浏览器未允许语音识别服务。',
  'audio-capture': '未检测到可用麦克风，请检查设备。',
  'no-speech': '未检测到语音，请重试。',
  network: '语音识别服务不可用，请检查网络。',
};

export default function useSpeechRecognition() {
  const recognitionRef = useRef(null);
  const [supported, setSupported] = useState(() => Boolean(getSpeechRecognition()));
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState('');

  const stopRecording = useCallback(() => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    setIsRecording(false);
    if (recognition) {
      try { recognition.stop(); } catch {}
    }
  }, []);

  useEffect(() => {
    setSupported(Boolean(getSpeechRecognition()));
    return () => {
      const recognition = recognitionRef.current;
      recognitionRef.current = null;
      if (recognition) {
        recognition.onend = null;
        recognition.onerror = null;
        recognition.onresult = null;
        try { recognition.abort(); } catch {}
      }
    };
  }, []);

  const toggleRecording = useCallback((value, onChange) => {
    const SpeechRecognition = getSpeechRecognition();
    if (!SpeechRecognition) {
      setSupported(false);
      return;
    }

    if (recognitionRef.current) {
      stopRecording();
      return;
    }

    const recognition = new SpeechRecognition();
    const initialValue = value || '';
    recognition.lang = 'zh-CN';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map(result => result[0]?.transcript || '')
        .join('');
      onChange(appendTranscript(initialValue, transcript));
    };
    recognition.onend = () => {
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      setIsRecording(false);
    };
    recognition.onerror = (event) => {
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      setIsRecording(false);
      setError(ERROR_MESSAGES[event.error] || '语音输入暂时不可用，请重试。');
    };

    recognitionRef.current = recognition;
    setError('');
    try {
      recognition.start();
      setIsRecording(true);
    } catch {
      recognitionRef.current = null;
      setIsRecording(false);
      setError('语音输入无法启动，请稍后重试。');
    }
  }, [stopRecording]);

  return { supported, isRecording, error, toggleRecording, stopRecording };
}
