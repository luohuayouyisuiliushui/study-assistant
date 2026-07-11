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

  /** SSE streaming: start interactive mode. Calls onEvent for each SSE event (chunk, pause, done, error). */
  async startInteractiveSSE(planId, topicId, mode, onEvent) {
    const settings = (() => { try { return JSON.parse(localStorage.getItem('textbook-maker-settings') || '{}'); } catch { return {}; } })();
    const headers = { 'Content-Type': 'application/json' };
    const body = JSON.stringify({ mode, apiKey: settings.apiKey, baseURL: settings.baseURL, model: settings.model });
    const response = await fetch(`${API_BASE}/learn/plans/${planId}/interactive-start-sse/${topicId}`, {
      method: 'POST', headers, body,
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

  /** SSE streaming: continue interactive mode. Calls onEvent for each SSE event. */
  async continueInteractiveSSE(planId, topicId, mode, feedback, onEvent) {
    const settings = (() => { try { return JSON.parse(localStorage.getItem('textbook-maker-settings') || '{}'); } catch { return {}; } })();
    const headers = { 'Content-Type': 'application/json' };
    const body = JSON.stringify({ mode, feedback, apiKey: settings.apiKey, baseURL: settings.baseURL, model: settings.model });
    const response = await fetch(`${API_BASE}/learn/plans/${planId}/interactive-continue-sse/${topicId}`, {
      method: 'POST', headers, body,
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

  // ─── Quick Quiz ───
  async generateQuickQuiz(planId) {
    return request(`${API_BASE}/learn/plans/${planId}/quick-quiz`, {
      method: 'POST',
    }, true);
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
    }, true);
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
    }, true);
  },

  // ─── Connection Test ───
  async testConnection(apiKey, baseURL, model) {
    return request(`${API_BASE}/learn/test-connection`, {
      method: 'POST',
      body: JSON.stringify({ apiKey, baseURL, model }),
    });
  },

  // ─── v1.6.0 Fact-Check (Anti-Hallucination) ───
  async factCheck(planId, topicId) {
    return request(`${API_BASE}/learn/plans/${planId}/fact-check/${topicId}`, {
      method: 'POST',
    }, true);
  },
  async autoFixFacts(planId, topicId, findings) {
    return request(`${API_BASE}/learn/plans/${planId}/fact-check-auto-fix/${topicId}`, {
      method: 'POST',
      body: JSON.stringify({ findings }),
    }, true);
  },

  // ─── v1.6.0 Adaptive Engine ───
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

  // ─── v1.6.0 Export Engine ───
  exportAnkiCSV(planId, topicId) {
    const settings = (() => { try { return JSON.parse(localStorage.getItem('textbook-maker-settings') || '{}'); } catch { return {}; } })();
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

  // ─── v1.6.1 Multi-Agent Dispatcher ───
  async listAgents() {
    return request(`${API_BASE}/learn/agents/list`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  async getAgentUsage() {
    return request(`${API_BASE}/learn/agents/usage`, {
      method: 'POST',
    }, true);
  },

  // ─── Exam System ───
  async listExams(planId) {
    return request(`${API_BASE}/learn/plans/${planId}/exams`);
  },
  async generateExam(planId, topicIds, config) {
    return request(`${API_BASE}/learn/plans/${planId}/exam/generate`, {
      method: 'POST',
      body: JSON.stringify({ topicIds, config }),
    }, true);
  },
  async generateExamStream(planId, topicIds, config, onEvent) {
    const settings = (() => { try { return JSON.parse(localStorage.getItem('textbook-maker-settings') || '{}'); } catch { return {}; } })();
    const headers = { 'Content-Type': 'application/json' };
    const body = JSON.stringify({ topicIds, config, apiKey: settings.apiKey, baseURL: settings.baseURL, model: settings.model });
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
    }, true);
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
    }, true);
  },

  // ─── Core Topics (Pareto 20%) ───
  async getCoreTopics(planId, force = false) {
    return request(`${API_BASE}/learn/plans/${planId}/core-topics`, {
      method: 'POST',
      body: force ? { force: true } : {},
    }, true);
  },
};

export default api;
