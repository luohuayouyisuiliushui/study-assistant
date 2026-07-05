const API_BASE = '/api';

/** Read API settings from localStorage (set by SettingsModal) */
function getApiSettings() {
  try {
    const raw = localStorage.getItem('textbook-maker-settings');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function request(url, options = {}, includeApiKey = false) {
  const headers = { 'Content-Type': 'application/json' };

  // Merge body with API settings for AI calls
  let body = options.body;
  if (includeApiKey) {
    const settings = getApiSettings();
    if (settings.apiKey) {
      const parsed = body ? JSON.parse(body) : {};
      parsed.apiKey = settings.apiKey;
      parsed.baseURL = settings.baseURL;
      parsed.model = settings.model;
      body = JSON.stringify(parsed);
    }
  }

  const fetchOpts = { headers, ...options };
  if (body !== undefined) fetchOpts.body = body;

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

  // ─── Learning Profile ───
  async getProfile(planId) {
    return request(`${API_BASE}/learn/plans/${planId}/profile`);
  },

  // ─── AI Import (needs API key) ───
  async importPlan(text) {
    return request(`${API_BASE}/learn/plans/import`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }, true); // includeApiKey
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

  // ─── Generation & Q&A (needs API key) ───
  async generateDetail(planId, topicId) {
    const settings = getApiSettings();
    const body = settings.imageApiKey ? JSON.stringify({ imageApiKey: settings.imageApiKey, imageModel: settings.imageModel }) : undefined;
    const headers = body ? { 'Content-Type': 'application/json' } : {};
    return request(`${API_BASE}/learn/plans/${planId}/generate/${topicId}`,
      { method: 'POST', body, headers }, true);
  },
  async askQuestion(planId, topicId, question) {
    return request(`${API_BASE}/learn/plans/${planId}/ask/${topicId}`, {
      method: 'POST',
      body: JSON.stringify({ question }),
    }, true);
  },

  // ─── Interactive Mode ───
  async startInteractive(planId, topicId, mode) {
    return request(`${API_BASE}/learn/plans/${planId}/interactive-start/${topicId}`, {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }, true);
  },
  async continueInteractive(planId, topicId, mode, feedback) {
    return request(`${API_BASE}/learn/plans/${planId}/interactive-continue/${topicId}`, {
      method: 'POST',
      body: JSON.stringify({ mode, feedback }),
    }, true);
  },

  // ─── Challenge: Reveal Embedded Errors ───
  async revealErrors(planId, topicId) {
    return request(`${API_BASE}/learn/plans/${planId}/reveal-errors/${topicId}`, {
      method: 'POST',
    }, true);
  },

  // ─── Scaffold: Decompose Topic ───
  async decomposeTopic(planId, topicId) {
    return request(`${API_BASE}/learn/plans/${planId}/decompose/${topicId}`, {
      method: 'POST',
    }, true);
  },

  // ─── TTS: Text-to-Speech ───
  async textToSpeech(text) {
    const settings = getApiSettings();
    if (!settings.imageApiKey) throw new Error('请先在设置中配置图片 API Key（硅基流动）');
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

  // ─── Time Tracking ───
  async recordTime(planId, topicId, seconds) {
    return request(`${API_BASE}/learn/plans/${planId}/topics/${topicId}/time`, {
      method: 'POST',
      body: JSON.stringify({ seconds }),
    });
  },

  // ─── Learning Analysis ───
  async analyzePlan(planId, analysisChat) {
    const body = { method: 'POST' };
    if (analysisChat && analysisChat.length > 0) {
      body.body = JSON.stringify({ analysisChat });
    }
    return request(`${API_BASE}/learn/plans/${planId}/analysis`, body, true);
  },
  async askAnalysisQuestion(planId, question, analysis) {
    return request(`${API_BASE}/learn/plans/${planId}/analysis/ask`, {
      method: 'POST',
      body: JSON.stringify({ question, analysis }),
    }, true);
  },
  // ─── Knowledge Graph ───
  async getKnowledgeGraph(planId, infer = false) {
    const qs = infer ? '?infer=true' : '';
    return request(`${API_BASE}/learn/plans/${planId}/graph${qs}`);
  },
  async extractRelations(planId) {
    return request(`${API_BASE}/learn/plans/${planId}/extract-relations`);
  },

  // ─── Exercises & Review (needs API key) ───
  async generateReview(planId, topicId) {
    return request(`${API_BASE}/learn/plans/${planId}/review/${topicId}`,
      { method: 'POST' }, true);
  },
  async submitExercises(planId, topicId, answers) {
    return request(`${API_BASE}/learn/plans/${planId}/exercises/${topicId}/submit`, {
      method: 'POST',
      body: JSON.stringify({ answers }),
    }, true);
  },
  async analyzeWeakPoints(planId) {
    return request(`${API_BASE}/learn/plans/${planId}/weak-points`,
      { method: 'POST' }, true);
  },
  async getReviewNeeds(planId) {
    return request(`${API_BASE}/learn/plans/${planId}/review-needs`);
  },

  // ─── Connection Test ───
  async testConnection(apiKey, baseURL, model) {
    return request(`${API_BASE}/learn/test-connection`, {
      method: 'POST',
      body: JSON.stringify({ apiKey, baseURL, model }),
    });
  },
};

export default api;
