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
    return request(`${API_BASE}/learn/plans/${planId}/generate/${topicId}`,
      { method: 'POST' }, true);
  },
  async askQuestion(planId, topicId, question) {
    return request(`${API_BASE}/learn/plans/${planId}/ask/${topicId}`, {
      method: 'POST',
      body: JSON.stringify({ question }),
    }, true);
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
};

export default api;
