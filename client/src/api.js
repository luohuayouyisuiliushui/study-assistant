import { loadSettings, selectTextProvider, selectTextFallbackProvider } from './lib/settings-storage';

const API_BASE = '/api';
const RESOURCE_RECOMMENDATION_TIMEOUT_MS = 65_000;

function getApiSettings() {
  return loadSettings();
}

/**
 * Inject provider credentials from the selected channel into the request body.
 * Accepts body as undefined, JSON string, or plain object.
 */
function injectProvider(body, settings, taskType, providerOverride) {
  const provider = providerOverride || selectTextProvider(settings, taskType);
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

async function request(url, options = {}, taskType = null, providerOverride = null) {
  const { timeoutMs = 0, timeoutMessage = '', ...requestOptions } = options;
  let body = requestOptions.body;

  if (taskType) {
    const settings = getApiSettings();
    body = injectProvider(body, settings, taskType, providerOverride);
  }

  const fetchOpts = { ...requestOptions };
  if (body !== undefined) {
    fetchOpts.headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    // Ensure body is a JSON string for fetch
    fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  const timeoutController = timeoutMs > 0 ? new AbortController() : null;
  let timeoutId = null;
  let timedOut = false;
  let externalAbortHandler = null;

  if (timeoutController) {
    const externalSignal = fetchOpts.signal;
    if (externalSignal) {
      externalAbortHandler = () => timeoutController.abort(externalSignal.reason);
      if (externalSignal.aborted) externalAbortHandler();
      else externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
    }
    fetchOpts.signal = timeoutController.signal;
    timeoutId = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, timeoutMs);
  }

  try {
    const res = await fetch(url, fetchOpts);
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(`服务器返回了空响应 (${res.status})${res.statusText ? ': ' + res.statusText : ''}`);
    }
    if (!res.ok || data.error) {
      throw new Error(data.error || `请求失败 (${res.status})`);
    }
    return data;
  } catch (err) {
    if (timedOut) throw new Error(timeoutMessage || '请求超时，请重试');
    throw err;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (externalAbortHandler) requestOptions.signal?.removeEventListener('abort', externalAbortHandler);
  }
}

function isContentSafetyBlock(err) {
  const message = String(err?.message || '').toLowerCase();
  return message.includes('内容安全策略') ||
    message.includes('request was blocked') ||
    message.includes('content_filter') ||
    message.includes('content filter') ||
    message.includes('content policy') ||
    message.includes('safety policy');
}

const api = {
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
    const settings = getApiSettings();
    const provider = selectTextProvider(settings, 'ask-question');
    const requestOptions = {
      method: 'POST',
      body: JSON.stringify({ question }),
    };
    const url = `${API_BASE}/learn/plans/${planId}/ask/${topicId}`;

    try {
      return await request(url, requestOptions, 'ask-question', provider);
    } catch (err) {
      const fallbackProvider = isContentSafetyBlock(err)
        ? selectTextFallbackProvider(settings, 'ask-question')
        : null;
      if (!fallbackProvider) throw err;
      return request(url, requestOptions, 'ask-question', fallbackProvider);
    }
  },

  // ─── Resource Recommendations ───
  async getResources(planId, topicId) {
    return request(`${API_BASE}/learn/plans/${planId}/resources/${topicId}`);
  },
  async recommendResources(planId, topicId) {
    return request(`${API_BASE}/learn/plans/${planId}/resources/${topicId}`, {
      method: 'POST',
      timeoutMs: RESOURCE_RECOMMENDATION_TIMEOUT_MS,
      timeoutMessage: '资源推荐超时，请重试',
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
  async submitFeedback(planId, topicId, reason, mode) {
    return request(`${API_BASE}/learn/plans/${planId}/topic/${topicId}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ reason, mode }),
    });
  },
  async submitExercises(planId, topicId, answers) {
    return request(`${API_BASE}/learn/plans/${planId}/exercises/${topicId}/submit`, {
      method: 'POST',
      body: JSON.stringify({ answers }),
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
  async submitQuickQuiz(planId, questions, results) {
    return request(`${API_BASE}/learn/plans/${planId}/quick-quiz/submit`, {
      method: 'POST',
      body: JSON.stringify({ questions, results }),
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
  async submitExam(planId, examId, answers) {
    return request(`${API_BASE}/learn/plans/${planId}/exam/${examId}/submit`, {
      method: 'POST',
      body: JSON.stringify({ answers }),
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
};

export default api;
