import { useState } from 'react';
import api from '../api';

const STORAGE_KEY = 'textbook-maker-settings';

function loadSettings() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : {};
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export default function SettingsModal({ isOpen, onClose, onSave }) {
  const saved = loadSettings();
  const [apiKey, setApiKey] = useState(saved.apiKey || '');
  const [baseURL, setBaseURL] = useState(saved.baseURL || 'https://api.openai.com/v1');
  const [model, setModel] = useState(saved.model || 'gpt-4o-mini');
  const [showKey, setShowKey] = useState(false);
  const [testResult, setTestResult] = useState(null); // { ok, model, error } | null
  const [testing, setTesting] = useState(false);

  if (!isOpen) return null;

  const handleTestConnection = async () => {
    if (!apiKey) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.testConnection(apiKey, baseURL, model);
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, error: err.message });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = () => {
    const settings = { apiKey, baseURL, model };
    saveSettings(settings);
    onSave(settings);
    onClose();
  };

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h2>⚙️ API 设置</h2>
        <p className="modal-hint">配置 AI 接口以使用知识点讲解功能</p>

        <div className="security-notice">
          ⚠️ API Key 会保存在浏览器本地存储中。建议仅在个人设备上使用，
          或配置服务端 <code>.env</code> 环境变量以避免 Key 暴露。
        </div>

        <label>
          API Key <span className="required">*</span>
          <div className="password-input">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="sk-..."
            />
            <button
              className="toggle-btn"
              onClick={() => setShowKey(!showKey)}
              type="button"
            >
              {showKey ? '🙈' : '👁️'}
            </button>
          </div>
        </label>

        <label>
          API Base URL
          <input
            type="text"
            value={baseURL}
            onChange={e => setBaseURL(e.target.value)}
            placeholder="https://api.openai.com/v1"
          />
        </label>

        <label>
          模型
          <input
            type="text"
            value={model}
            onChange={e => setModel(e.target.value)}
            placeholder="gpt-4o-mini"
          />
          <span className="field-hint">支持 OpenAI、DeepSeek、SiliconFlow 等兼容 API</span>
        </label>

        {testResult && (
          <div className={`test-result ${testResult.ok ? 'test-success' : 'test-fail'}`}>
            {testResult.ok
              ? `✅ 连接成功！模型: ${testResult.model || model}`
              : `❌ 连接失败: ${testResult.error}`}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>取消</button>
          <button
            className="btn btn-test"
            onClick={handleTestConnection}
            disabled={!apiKey || testing}
          >
            {testing ? '⏳ 测试中...' : '🔍 测试连接'}
          </button>
          <button className="btn btn-primary" onClick={handleSave} disabled={!apiKey}>
            保存并开始
          </button>
        </div>
      </div>
    </div>
  );
}
