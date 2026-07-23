import { loadSettings, selectTextProvider } from './lib/settings-storage';

const API_BASE = '/api';

export function createAttemptRef(prefix = 'attempt') {
  const randomPart = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${randomPart}`.slice(0, 128);
}

function getApiSettings() {
  return loadSettings();
}

function isQueueableOfflineMutation(url, options) {
  return options.method === 'PATCH' && /\/api\/learn\/plans\/[^/]+\/topics\/[^/]+\/resources\/\d+\/rating$/.test(url);
}

function queueOfflineMutation(url, options, body) {
  const controller = navigator.serviceWorker?.controller;
  if (!controller) return false;
  controller.postMessage({
    type: 'OFFLINE_QUEUE',
    payload: {
      url: new URL(url, window.location.origin).href,
      method: options.method,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      body: body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body)),
    },
  });
  return true;
}

if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('online', () => {
    navigator.serviceWorker.controller?.postMessage({ type: 'REPLAY_OFFLINE_QUEUE' });
  });
}

/**
 * Inject provider credentials from the selected channel into the request body.
 * Accepts body as undefined, JSON string, or plain object.
 */
function injectProvider(body, settings, taskType) {
  const provider = selectTextProvider(settings, taskType);
  if (!provider.apiKey) return body;

  let parsed = {};
  if (typeof body === 'string') {
    try { parsed = JSON.parse(body); } catch { parsed = {}; }
  } else if (body && typeof body === 'object') {
    parsed = { ...body };
  }

  parsed.apiKey = provider.apiKey;
  parsed.baseURL = provider.baseURL;
  parsed.model = provider.model;
  return JSON.stringify(parsed);
}

/**
 * Translate HTTP status codes and known error messages into actionable Chinese prompts.
 * The returned string is safe to display directly in the UI.
 */
function humanizeError(status, serverMessage) {
  // Prefer a specific server message when it looks meaningful
  const msg = serverMessage || '';

  if (status === 401 || msg.includes('Incorrect API key') || msg.includes('invalid_api_key') || msg.includes('Authentication')) {
    return 'API Key 无效或已过期，请前往设置重新填写。';
  }
  if (status === 403 || msg.includes('Permission') || msg.includes('permission')) {
    return 'API Key 权限不足，请确认 Key 是否支持当前模型。';
  }
  if (status === 429 || msg.includes('Rate limit') || msg.includes('rate_limit') || msg.includes('quota')) {
    return '请求频率或配额超限（429），请稍等片刻后重试，或切换到其他 API Key。';
  }
  if (status === 402 || msg.includes('insufficient_quota') || msg.includes('Billing')) {
    return 'API 余额不足，请前往服务商补充额度。';
  }
  if (status === 503 || status === 502 || status === 504) {
    return `AI 服务暂时不可用（${status}），请稍后重试或更换 Base URL。`;
  }
  if (status === 500) {
    return `服务器内部错误（500）${msg ? '：' + msg : ''}，请重试或重启后端服务。`;
  }
  if (status === 404) {
    return `找不到该资源（404）${msg ? '：' + msg : ''}。`;
  }
  if (msg) return msg;
  if (status) return `请求失败（${status}），请检查网络或 API 配置后重试。`;
  return '网络请求失败，请检查后端服务是否正在运行。';
}

async function request(url, options = {}, taskType = null) {
  let body = options.body;

  if (taskType) {
    const settings = getApiSettings();
    body = injectProvider(body, settings, taskType);
  }

  const fetchOpts = { ...options };
  if (body !== undefined) {
    fetchOpts.headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, fetchOpts);
  } catch (networkErr) {
    if (isQueueableOfflineMutation(url, options) && queueOfflineMutation(url, options, body)) {
      return { queued: true };
    }
    throw new Error('无法连接到后端服务，请确认服务已启动（npm run dev）。');
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(humanizeError(res.status, null));
  }
  if (!res.ok || data.error) {
    throw new Error(humanizeError(res.status, data.error));
  }
  return data;
}

const api = {
  createAttemptRef,
  // ─── Plans (no AI needed) ───
  async listPlans() {
    return request(`${API_BASE}/learn/plans`);
  },
  async getPlan(id) {
    return request(`${API_BASE}/learn/plans/${id}`);
  },
  async createPlan(name) {
    return request(`${API_BASE}/learn/plans`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  },
  async deletePlan(id) {
    return request(`${API_BASE}/learn/plans/${id}`, { method: 'DELETE' });
  },

  // ─── Trash / Recycle Bin ───
  async listTrash() {
    return request(`${API_BASE}/learn/trash`);
  },
  async restorePlan(id) {
    return request(`${API_BASE}/learn/trash/${id}/restore`, { method: 'POST' });
  },
  async permanentlyDeleteTrash(id) {
    return request(`${API_BASE}/learn/trash/${id}`, { method: 'DELETE' });
  },
  async emptyTrash() {
    return request(`${API_BASE}/learn/trash`, { method: 'DELETE' });
  },

  // ─── Learning Profile ───
  async getProfile(planId) {
    return request(`${API_BASE}/learn/plans/${planId}/profile`);
  },

  // ─── AI Import ───
  async importPlan(text) {
    return request(`${API_BASE}/learn/plans/import`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }, 'import-plan');
  },

  // ─── Topics ───
  async addTopics(planId, titles) {
    return request(`${API_BASE}/learn/plans/${planId}/topics`, {
      method: 'POST',
      body: JSON.stringify({ titles }),
    });
  },
  async removeTopic(planId, topicId) {
    return request(`${API_BASE}/learn/plans/${planId}/topics/${topicId}`, { method: 'DELETE' });
  },
  async updateTopic(planId, topicId, updates) {
    return request(`${API_BASE}/learn/plans/${planId}/topics/${topicId}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },
  async undoneTopic(planId, topicId) {
    return request(`${API_BASE}/learn/plans/${planId}/topics/${topicId}/undone`, {
      method: 'PATCH',
    });
  },

  // ─── Generation & Q&A ───
  async generateDetail(planId, topicId) {
    const settings = getApiSettings();
    let body = settings.imageApiKey ? { imageApiKey: settings.imageApiKey, imageModel: settings.imageModel, imageBaseUrl: settings.imageBaseUrl || '' } : undefined;
    if (settings.explainStyle) {
      body = { ...(body || {}), explainStyle: settings.explainStyle };
    }
    return request(`${API_BASE}/learn/plans/${planId}/generate/${topicId}`,
      { method: 'POST', body }, 'generate-detail');
  },
  async askQuestion(planId, topicId, question) {
    return request(`${API_BASE}/learn/plans/${planId}/ask/${topicId}`, {
      method: 'POST',
      body: JSON.stringify({ question }),
    }, 'ask-question');
  },

  // ─── Resource Recommendations ───
  async getResources(planId, topicId) {
    return request(`${API_BASE}/learn/plans/${planId}/resources/${topicId}`);
  },
  async recommendResources(planId, topicId) {
    return request(`${API_BASE}/learn/plans/${planId}/resources/${topicId}`, {
      method: 'POST',
    }, 'generate-detail');
  },

  // ─── Interactive Mode ───
  async startInteractive(planId, topicId, mode) {
    return request(`${API_BASE}/learn/plans/${planId}/interactive-start/${topicId}`, {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }, 'interactive-start');
  },
  async continueInteractive(planId, topicId, mode, feedback) {
    return request(`${API_BASE}/learn/plans/${planId}/interactive-continue/${topicId}`, {
      method: 'POST',
      body: JSON.stringify({ mode, feedback }),
    }, 'interactive-continue');
  },
  async clearInteractiveSession(planId, topicId) {
    return request(`${API_BASE}/learn/plans/${planId}/interactive-session/${topicId}`, {
      method: 'DELETE',
    });
  },

  /** SSE streaming: start interactive mode. */
  async startInteractiveSSE(planId, topicId, mode, onEvent, signal) {
    const settings = getApiSettings();
    const provider = selectTextProvider(settings, 'interactive-start-sse');
    const headers = { 'Content-Type': 'application/json' };
    const body = JSON.stringify({ mode, apiKey: provider.apiKey, baseURL: provider.baseURL, model: provider.model });
    const response = await fetch(`${API_BASE}/learn/plans/${planId}/interactive-start-sse/${topicId}`, {
      method: 'POST', headers, body, signal,
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: '启动失败' }));
      throw new Error(err.error || '启动失败');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try { onEvent(JSON.parse(line.slice(6))); } catch {}
        }
      }
    }
  },

  /** SSE streaming: continue interactive mode. */
  async continueInteractiveSSE(planId, topicId, mode, feedback, onEvent, signal) {
    const settings = getApiSettings();
    const provider = selectTextProvider(settings, 'interactive-continue-sse');
    const headers = { 'Content-Type': 'application/json' };
    const body = JSON.stringify({ mode, feedback, apiKey: provider.apiKey, baseURL: provider.baseURL, model: provider.model });
    const response = await fetch(`${API_BASE}/learn/plans/${planId}/interactive-continue-sse/${topicId}`, {
      method: 'POST', headers, body, signal,
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: '继续失败' }));
      throw new Error(err.error || '继续失败');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try { onEvent(JSON.parse(line.slice(6))); } catch {}
        }
      }
    }
  },

  // ─── Challenge: Reveal Embedded Errors ───
  async revealErrors(planId, topicId, recognizedErrors = []) {
    return request(`${API_BASE}/learn/plans/${planId}/reveal-errors/${topicId}`, {
      method: 'POST',
      body: JSON.stringify({ recognizedErrors }),
    }, 'reveal-errors');
  },

  // ─── Scaffold: Decompose Topic ───
  async decomposeTopic(planId, topicId) {
    return request(`${API_BASE}/learn/plans/${planId}/decompose/${topicId}`, {
      method: 'POST',
    }, 'decompose-topic');
  },

  // ─── TTS (imageApiKey only, no text channel) ───
  async textToSpeech(text) {
    const settings = getApiSettings();
    if (!settings.imageApiKey) throw new Error('请先在设置中配置图片 API Key');
    const res = await fetch(`${API_BASE}/learn/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, imageApiKey: settings.imageApiKey }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'TTS 请求失败' }));
      throw new Error(err.error || 'TTS 请求失败');
    }
    return res.blob();
  },

  // ─── Time Tracking (no AI) ───
  async recordTime(planId, topicId, seconds) {
    return request(`${API_BASE}/learn/plans/${planId}/topics/${topicId}/time`, {
      method: 'POST',
      body: JSON.stringify({ seconds }),
    });
  },

  // ─── Image Generation (imageApiKey only, no text channel) ───
  async generateTopicImage(planId, topicId) {
    const settings = getApiSettings();
    const body = {};
    if (settings.imageApiKey) body.imageApiKey = settings.imageApiKey;
    if (settings.imageModel) body.imageModel = settings.imageModel;
    if (settings.imageBaseUrl) body.imageBaseUrl = settings.imageBaseUrl;
    return request(`${API_BASE}/learn/plans/${planId}/image/${topicId}`, {
      method: 'POST',
      body,
    });
  },

  // ─── Learning Analysis ───
  async analyzePlan(planId, analysisChat) {
    const body = { method: 'POST' };
    if (analysisChat && analysisChat.length > 0) {
      body.body = JSON.stringify({ analysisChat });
    }
    return request(`${API_BASE}/learn/plans/${planId}/analysis`, body, 'analyze-learning');
  },
  async askAnalysisQuestion(planId, question, analysis) {
    return request(`${API_BASE}/learn/plans/${planId}/analysis/ask`, {
      method: 'POST',
      body: JSON.stringify({ question, analysis }),
    }, 'analysis-ask');
  },

  // ─── Knowledge Graph ───
  async getKnowledgeGraph(planId, infer = false) {
    const qs = infer ? '?infer=true' : '';
    return request(`${API_BASE}/learn/plans/${planId}/graph${qs}`);
  },
  async extractRelations(planId) {
    return request(`${API_BASE}/learn/plans/${planId}/extract-relations`);
  },
  async inferRelations(planId) {
    return request(`${API_BASE}/learn/plans/${planId}/infer-relations`, {
      method: 'POST',
    }, 'infer-relations');
  },

  // ─── Exercises & Review ───
  async generateReview(planId, topicId) {
    return request(`${API_BASE}/learn/plans/${planId}/review/${topicId}`,
      { method: 'POST' }, 'generate-review');
  },
  async generateMistakeRepair(planId, topicId, mistakeId) {
    return request(
      `${API_BASE}/learn/plans/${planId}/topics/${topicId}/mistakes/${mistakeId}/repair`,
      { method: 'POST' },
      'generate-mistake-repair'
    );
  },
  async dismissMistake(planId, topicId, mistakeId, reason) {
    return request(
      `${API_BASE}/learn/plans/${planId}/topics/${topicId}/mistakes/${mistakeId}/dismiss`,
      { method: 'POST', body: JSON.stringify({ reason }) },
      'dismiss-mistake'
    );
  },
  async getTodayReviews(limit = 20) {
    return request(`${API_BASE}/learn/reviews/today?limit=${encodeURIComponent(limit)}`);
  },
  async submitFeedback(planId, topicId, reason, mode) {
    return request(`${API_BASE}/learn/plans/${planId}/topic/${topicId}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ reason, mode }),
    });
  },
  async submitExercises(planId, topicId, answers, attemptRef, assessment = {}) {
    return request(`${API_BASE}/learn/plans/${planId}/exercises/${topicId}/submit`, {
      method: 'POST',
      body: JSON.stringify({ answers, attemptRef, ...assessment }),
    }, 'submit-exercises');
  },
  async submitReviewExercises(planId, topicId, answers, sessionId, attemptRef) {
    return request(`${API_BASE}/learn/plans/${planId}/exercises/${topicId}/submit`, {
      method: 'POST',
      body: JSON.stringify({ answers, attemptRef, context: 'review', sessionId }),
    }, 'submit-exercises');
  },
  async submitRepairExercises(planId, topicId, mistakeId, answers, sessionId, attemptRef) {
    return request(`${API_BASE}/learn/plans/${planId}/exercises/${topicId}/submit`, {
      method: 'POST',
      body: JSON.stringify({ answers, attemptRef, context: 'repair', sessionId, mistakeId }),
    }, 'submit-exercises');
  },
  async analyzeWeakPoints(planId) {
    return request(`${API_BASE}/learn/plans/${planId}/weak-points`,
      { method: 'POST' }, 'weak-points');
  },
  async getReviewNeeds(planId) {
    return request(`${API_BASE}/learn/plans/${planId}/review-needs`);
  },

  // ─── Quick Quiz ───
  async generateQuickQuiz(planId) {
    return request(`${API_BASE}/learn/plans/${planId}/quick-quiz`, {
      method: 'POST',
    }, 'quick-quiz');
  },
  async submitQuickQuiz(planId, questions, results, attemptRef) {
    return request(`${API_BASE}/learn/plans/${planId}/quick-quiz/submit`, {
      method: 'POST',
      body: JSON.stringify({ questions, results, attemptRef }),
    });
  },

  async analyzeFeynmanSession(planId, topicId) {
    return request(`${API_BASE}/learn/plans/${planId}/feynman-analyze/${topicId}`, {
      method: 'POST',
    }, 'feynman-analyze');
  },

  // ─── User Profile ───
  async getUserProfileSummary() {
    return request(`${API_BASE}/user-profile/summary`);
  },
  async getUserProfile() {
    return request(`${API_BASE}/user-profile`);
  },
  async analyzeUserProfile() {
    return request(`${API_BASE}/user-profile/analyze`, {
      method: 'POST',
    }, 'user-profile-analyze');
  },

  // ─── Connection Test ───
  async testConnection(apiKey, baseURL, model) {
    return request(`${API_BASE}/learn/test-connection`, {
      method: 'POST',
      body: JSON.stringify({ apiKey, baseURL, model }),
    });
  },

  // ─── Server-side Settings ───
  async saveEnvKey(apiKey, baseURL, model) {
    return request(`${API_BASE}/settings/env-key`, {
      method: 'POST',
      body: JSON.stringify({ apiKey, baseURL, model }),
    });
  },
  async checkEnvKey() {
    return request(`${API_BASE}/settings/env-key`);
  },

  // ─── Fact-Check ───
  async factCheck(planId, topicId) {
    return request(`${API_BASE}/learn/plans/${planId}/fact-check/${topicId}`, {
      method: 'POST',
    }, 'fact-check');
  },
  async autoFixFacts(planId, topicId, findings) {
    return request(`${API_BASE}/learn/plans/${planId}/fact-check-auto-fix/${topicId}`, {
      method: 'POST',
      body: JSON.stringify({ findings }),
    }, 'auto-fix-facts');
  },

  // ─── Adaptive Engine ───
  async adaptiveAnalysis(planId) {
    return request(`${API_BASE}/learn/plans/${planId}/adaptive-analysis`, {
      method: 'POST',
    });
  },
  async getAdaptiveContext() {
    return request(`${API_BASE}/learn/adaptive-context`, {
      method: 'POST',
    });
  },

  // ─── Export Engine (no AI) ───
  exportAnkiCSV(planId, topicId) {
    return `${API_BASE}/learn/plans/${planId}/export/anki/${topicId}`;
  },
  exportOPML(planId, topicId) {
    return `${API_BASE}/learn/plans/${planId}/export/opml/${topicId}`;
  },
  exportNotionCSV(planId) {
    return `${API_BASE}/learn/plans/${planId}/export/notion`;
  },
  exportJSON(planId, topicId) {
    return `${API_BASE}/learn/plans/${planId}/export/json/${topicId}`;
  },
  exportStudyNotes(planId, topicId) {
    return `${API_BASE}/learn/plans/${planId}/export/notes/${topicId}`;
  },
  exportHTML(planId, topicId) {
    return `${API_BASE}/export/plans/${planId}/export/html/${topicId}`;
  },
  exportBundle(planId) {
    return `${API_BASE}/learn/plans/${planId}/export/bundle`;
  },

  // ─── Multi-Agent Dispatcher ───
  async listAgents() {
    return request(`${API_BASE}/learn/agents/list`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  async getAgentUsage() {
    return request(`${API_BASE}/learn/agents/usage`, {
      method: 'POST',
    });
  },

  // ─── Exam System ───
  async listExams(planId) {
    return request(`${API_BASE}/learn/plans/${planId}/exams`);
  },
  async generateExam(planId, topicIds, config) {
    return request(`${API_BASE}/learn/plans/${planId}/exam/generate`, {
      method: 'POST',
      body: JSON.stringify({ topicIds, config }),
    }, 'generate-exam');
  },
  async generateExamStream(planId, topicIds, config, onEvent) {
    const settings = getApiSettings();
    const provider = selectTextProvider(settings, 'generate-exam');
    const headers = { 'Content-Type': 'application/json' };
    const body = JSON.stringify({ topicIds, config, apiKey: provider.apiKey, baseURL: provider.baseURL, model: provider.model });
    const response = await fetch(`${API_BASE}/learn/plans/${planId}/exam/generate-stream`, {
      method: 'POST', headers, body,
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: '组卷失败' }));
      throw new Error(err.error || '组卷失败');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try { onEvent(JSON.parse(line.slice(6))); } catch {}
        }
      }
    }
  },
  async submitExam(planId, examId, answers, attemptRef) {
    return request(`${API_BASE}/learn/plans/${planId}/exam/${examId}/submit`, {
      method: 'POST',
      body: JSON.stringify({ answers, attemptRef }),
    }, 'submit-exam');
  },
  async deleteExam(planId, examId) {
    return request(`${API_BASE}/learn/plans/${planId}/exam/${examId}`, {
      method: 'DELETE',
    });
  },
  async practiceExam(planId, examId, count) {
    return request(`${API_BASE}/learn/plans/${planId}/exam/${examId}/practice`, {
      method: 'POST',
      body: JSON.stringify({ count }),
    }, 'exam-practice');
  },

  // ─── Core Topics (Pareto 20%) ───
  async getCoreTopics(planId, force = false) {
    const body = force ? { force: true } : undefined;
    return request(`${API_BASE}/learn/plans/${planId}/core-topics`, {
      method: 'POST',
      body,
    }, 'get-core-topics');
  },

  // ─── Bundle Import ───
  async importBundle(bundleJson) {
    return request(`${API_BASE}/learn/plans/import/bundle`, {
      method: 'POST',
      body: JSON.stringify(bundleJson),
    }, 'import-bundle');
  },

  // ─── Resource Rating ───
  async rateResource(planId, topicId, idx, rating) {
    return request(`${API_BASE}/learn/plans/${planId}/topics/${topicId}/resources/${idx}/rating`, {
      method: 'PATCH',
      body: JSON.stringify({ rating }),
    });
  },
};

export default api;
