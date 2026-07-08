import { useState, useEffect, useRef, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import MermaidDiagram from './MermaidDiagram';
import api from '../api';

// 教学错误类型编码 → 中文标签（与后端 MISCONCEPTION_TAXONOMY 保持一致）
const ERROR_TYPE_LABELS = {
  boundary: '边界条件偏差',
  'concept-approx': '概念近似但不精确',
  'concept-confusion': '概念混淆',
  'causal-fallacy': '因果谬误',
  overgeneralization: '过度概括',
  'code-bug': '代码错误',
  'symbol-slip': '符号/计算错误',
  procedural: '步骤缺失/顺序错误',
};

// Custom component map for ReactMarkdown — handles Mermaid diagrams
const markdownComponents = {
  code({ className, children, ...props }) {
    const isInline = !props?.node?.properties?.className && !className;
    const code = String(children).replace(/\n$/, '');

    // Mermaid code block: class is "language-mermaid"
    if (className && className.includes('language-mermaid') && !isInline) {
      return <MermaidDiagram code={code} />;
    }

    // Inline code
    if (isInline) {
      return <code {...props}>{children}</code>;
    }

    // Regular code block
    return (
      <pre {...props}>
        <code className={className}>{children}</code>
      </pre>
    );
  },
};

// Memo-optimized content area — only re-renders when the markdown string changes
const ContentArea = memo(function ContentArea({ content }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={markdownComponents}>{content}</ReactMarkdown>;
});

// Memo-optimized Q&A message list — only re-renders when qaList changes
const QaMessages = memo(function QaMessages({ qaList }) {
  return qaList.length === 0 ? (
    <div className="chat-empty">暂无追问，在下方输入问题开始讨论</div>
  ) : (
    qaList.map((qa, i) => (
      <div key={i} className="chat-message-group" data-round={i}>
        {/* User message */}
        <div className="chat-message user">
          <div className="chat-bubble user-bubble">
            {qa.question}
          </div>
        </div>
        {/* AI message */}
        <div className="chat-message ai">
          <div className="chat-avatar">🤖</div>
          <div className="chat-bubble ai-bubble">
            {qa.answer === '...' ? (
              <span className="typing-text">思考中...</span>
            ) : (
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={markdownComponents}>{qa.answer}</ReactMarkdown>
            )}
          </div>
        </div>
      </div>
    ))
  );
});

/** Parse exercises from AI-generated markdown content (client-side) */
function parseExercisesFromMarkdown(detail) {
  if (!detail) return [];
  const exercises = [];
  const lines = detail.split('\n');
  let current = null;
  let inSection = false;

  for (const line of lines) {
    const t = line.trim();
    if (t.includes('📝 练习题') || /^#{1,3}\s*练习题/.test(t)) { inSection = true; continue; }
    if (!inSection) continue;

    const m = t.match(/^>\s*\*\*练习题\s*(\d+)\*\*\s*[（(]([^)）]+)[)）]/);
    if (m) {
      if (current) exercises.push(current);
      current = { index: parseInt(m[1]), type: m[2] === '选择题' ? 'choice' : 'open', question: '', options: [], answer: '', explanation: '', conceptTag: '', userAnswer: null, correct: null };
      // Find closing paren (ASCII or full-width) to extract question text
      const parenEnd = t.search(/[)）]/);
      if (parenEnd >= 0 && parenEnd + 1 < t.length) current.question = t.slice(parenEnd + 1).replace(/^[）)]\s*/, '').trim();
      continue;
    }
    if (!current) continue;
    const opt = t.match(/^>\s*-\s*([A-D])[.．、]\s*(.+)/);
    if (opt) { current.options.push(opt[1] + '. ' + opt[2]); continue; }
    const ans = t.match(/^>\s*>\s*(?:正确答案|参考答案)[：:]\s*(.+)/);
    if (ans) { current.answer = ans[1].trim(); continue; }
    const exp = t.match(/^>\s*>\s*解析[：:]\s*(.+)/);
    if (exp) { current.explanation = exp[1].trim(); continue; }
    const conc = t.match(/^>\s*>\s*关联概念[：:]\s*(.+)/);
    if (conc) { current.conceptTag = conc[1].trim(); continue; }
    if (t.startsWith('> ') && !t.startsWith('> -') && !t.startsWith('> >') && !t.startsWith('> **练习题')) {
      const txt = t.slice(2).trim();
      if (txt && !current.answer) current.question += (current.question ? ' ' : '') + txt;
    }
  }
  if (current) exercises.push(current);
  return exercises;
}

export default function TopicDetail({ plan, topic, onBack, onRefresh, onSelectTopic }) {
  const [qaInput, setQaInput] = useState('');
  const [qaList, setQaList] = useState([]);
  const [qaLoading, setQaLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [localDetail, setLocalDetail] = useState(topic?.detail || '');
  const qaInputRef = useRef(null);
  const chatPanelRef = useRef(null);
  const genTriggered = useRef(false); // prevent double trigger
  const startTimeRef = useRef(Date.now()); // time tracking
  const [difficulty, setDifficulty] = useState(topic?.difficulty || null);
  const [difficultySaving, setDifficultySaving] = useState(false);
  const [hoveredRound, setHoveredRound] = useState(null);
  const [revealErrors, setRevealErrors] = useState(null); // null | { hasErrors, errors }
  const [revealLoading, setRevealLoading] = useState(false);
  const [foundErrorsInput, setFoundErrorsInput] = useState('');
  const lastReportedRef = useRef(0);
  const settings = (() => { try { return JSON.parse(localStorage.getItem('textbook-maker-settings') || '{}'); } catch { return {}; } })();

  // ─── Exercise State ───
  const [exercises, setExercises] = useState([]);
  const [exerciseAnswers, setExerciseAnswers] = useState({});
  const [exerciseResults, setExerciseResults] = useState(null);
  const [exerciseLoading, setExerciseLoading] = useState(false);
  const [submittedExercises, setSubmittedExercises] = useState(false);

  // ─── Review Mode State ───
  const [reviewMode, setReviewMode] = useState(false);
  const [reviewContent, setReviewContent] = useState(topic?.reviewGenerated || null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState(null);

  // ─── Interactive Mode State ───
  const [interactiveMode, setInteractiveMode] = useState(null); // null | 'stepwise' | 'realtime'
  const [interactiveSections, setInteractiveSections] = useState([]);
  const [streamingContent, setStreamingContent] = useState(''); // progressive SSE content
  const [interactiveLoading, setInteractiveLoading] = useState(false);
  const [interactiveFinished, setInteractiveFinished] = useState(false);
  const [interactiveInput, setInteractiveInput] = useState('');
  const [interactiveStateMachine, setInteractiveStateMachine] = useState(null);
  const interactiveInputRef = useRef(null);
  const interactiveBusyRef = useRef(false);

  // ─── Voice Input State ───
  const [isRecording, setIsRecording] = useState(false);
  const recognitionRef = useRef(null);
  const [voiceSupported, setVoiceSupported] = useState(true);

  // Check Web Speech API support on mount
  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setVoiceSupported(false);
    }
  }, []);

  // Cleanup recognition on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try { recognitionRef.current.abort(); } catch {}
      }
    };
  }, []);

  // Record time spent — heartbeat every 30s + flush on leave
  useEffect(() => {
    const pid = plan?.id;
    const tid = topic?.id;
    startTimeRef.current = Date.now();
    lastReportedRef.current = 0;

    // Periodic heartbeat: send accumulated time every 30s
    const heartbeat = setInterval(async () => {
      const total = Math.round((Date.now() - startTimeRef.current) / 1000);
      const unreported = total - lastReportedRef.current;
      if (unreported >= 5 && pid && tid) {
        try {
          await api.recordTime(pid, tid, unreported);
          lastReportedRef.current = total;
        } catch { /* ignore */ }
      }
    }, 30000);

    return () => {
      clearInterval(heartbeat);
      // Send remaining time on leave
      const elapsed = Math.round((Date.now() - startTimeRef.current) / 1000);
      const unreported = elapsed - lastReportedRef.current;
      if (unreported >= 5 && pid && tid) {
        api.recordTime(pid, tid, unreported).catch(() => {});
      }
    };
  }, [topic?.id]);

  // Load Q&A history from plan (only on topic change, not on every plan refresh)
  useEffect(() => {
    setLocalDetail(topic?.detail || '');
    setError(topic?.lastError || null);

    // Only load Q&A history on initial topic mount, skip if already has items
    const history = plan.history?.filter(h => h.topicId === topic?.id) || [];
    const pairs = [];
    for (let i = 0; i < history.length; i++) {
      if (history[i].role === 'user' && i + 1 < history.length && history[i + 1].role === 'ai') {
        pairs.push({ question: history[i].content, answer: history[i + 1].content });
        i++;
      }
    }
    // Only set if we don't have a pending question (answer === '...')
    setQaList(prev => {
      const hasPending = prev.some(q => q.answer === '...');
      if (hasPending) return prev; // don't overwrite mid-Q&A
      return pairs;
    });
  }, [topic?.id]); // removed plan.history to prevent overwrite during polls

  // Parse exercises from detail content
  useEffect(() => {
    if (!localDetail || generating) return;
    // Only parse if we haven't loaded exercises from saved topic data
    if (topic?.exercises && topic.exercises.length > 0) {
      setExercises(topic.exercises);
      // Check if all exercises have been submitted
      if (topic.exercises.every(e => e.correct !== null)) {
        setSubmittedExercises(true);
        setExerciseResults(topic.exercises.map((e, idx) => ({
          exerciseIndex: idx,
          correct: e.correct,
          userAnswer: e.userAnswer,
          correctAnswer: e.answer,
          explanation: e.explanation,
        })));
      }
      return;
    }
    // Parse from markdown detail
    const parsed = parseExercisesFromMarkdown(localDetail);
    if (parsed.length > 0) {
      setExercises(parsed);
    }
  }, [localDetail, generating, topic?.exercises]);

  // Scroll chat panel to bottom on new Q&A
  useEffect(() => {
    if (chatPanelRef.current) {
      chatPanelRef.current.scrollTop = chatPanelRef.current.scrollHeight;
    }
  }, [qaList.length]);

  // Scroll to a specific round
  const scrollToRound = (index) => {
    const container = chatPanelRef.current;
    if (!container) return;
    const target = container.querySelector(`[data-round="${index}"]`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  // Auto-generate on first load (only once)
  useEffect(() => {
    if (!topic || genTriggered.current) return;
    if (topic.detail && topic.done) {
      setGenerating(false);
      return;
    }
    if (topic.lastError) {
      setError(topic.lastError);
      return;
    }
    // If detail is empty and not errored, trigger generation
    if (!topic.detail && !topic.done && !topic.lastError) {
      genTriggered.current = true;
      setGenerating(true);
      api.generateDetail(plan.id, topic.id).catch(err => {
        console.error('[TopicDetail] generateDetail failed:', err);
        setGenerating(false);
        setError(err.message || '加载失败');
      });
    }
  }, [topic?.id]);

  // Regenerate only the illustration image for this topic
  const handleGenerateImage = async (topicId) => {
    setGenerating(true);
    try {
      await api.generateDetail(plan.id, topicId);
      // Wait a moment then refresh
      setTimeout(async () => {
        const fresh = await api.getPlan(plan.id);
        if (fresh.plan) {
          setTopic(fresh.plan.topics.find(t => t.id === topicId));
        }
        setGenerating(false);
      }, 5000);
    } catch {
      setGenerating(false);
    }
  };

  // Auto-focus Q&A input when generation completes
  useEffect(() => {
    if (!generating && localDetail && !error) {
      qaInputRef.current?.focus();
    }
  }, [generating, localDetail, error]);

  // Poll for generation progress (intermediate content + error detection)
  useEffect(() => {
    if (!generating || !plan) return;
    const timer = setInterval(async () => {
      try {
        const d = await api.getPlan(plan.id);
        const t = d.plan.topics.find(t => t.id === topic?.id);
        if (!t) { clearInterval(timer); return; }

        if (t.detail && t.detail !== localDetail) {
          setLocalDetail(t.detail);
          onRefresh(d.plan);
        }
        if (t.lastError) {
          setError(t.lastError);
          setGenerating(false);
          clearInterval(timer);
        }
        if (t.done && !t.lastError) {
          setLocalDetail(t.detail || localDetail);
          setGenerating(false);
          clearInterval(timer);
        }
      } catch { clearInterval(timer); }
    }, 2000);
    return () => clearInterval(timer);
  }, [generating, plan?.id, topic?.id]);

  if (!topic) return null;

  const handleAsk = async () => {
    if (!qaInput.trim() || qaLoading) return;
    const question = qaInput.trim();
    setQaInput('');
    setQaLoading(true);
    setQaList(prev => [...prev, { question, answer: '...' }]);

    try {
      const d = await api.askQuestion(plan.id, topic.id, question);
      setQaList(prev => {
        const list = [...prev];
        list[list.length - 1] = { question, answer: d.answer };
        return list;
      });
      // Scroll to bottom when answer arrives
      requestAnimationFrame(() => {
        if (chatPanelRef.current) {
          chatPanelRef.current.scrollTop = chatPanelRef.current.scrollHeight;
        }
      });
      const fresh = await api.getPlan(plan.id);
      onRefresh(fresh.plan);
      setTimeout(() => qaInputRef.current?.focus(), 100);
    } catch (err) {
      setQaList(prev => {
        const list = [...prev];
        list[list.length - 1] = { question, answer: `❌ 请求失败: ${err.message}` };
        return list;
      });
    } finally {
      setQaLoading(false);
    }
  };

  const handleExport = () => {
    if (!localDetail) return;
    let md = `# ${topic.title}\n\n`;
    md += topic.detail + '\n\n';
    if (qaList.length > 0) {
      md += `---\n\n## 📎 扩展讨论\n\n`;
      qaList.forEach((qa, i) => {
        md += `### 追问 ${i + 1}\n\n${qa.question}\n\n`;
        md += `> ${qa.answer}\n\n`;
      });
    }
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${topic.title}.md`.replace(/[/\\?%*:|"<>]/g, '_');
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportHtml = async () => {
    if (!localDetail) return;

    // Build the full Markdown content (same as handleExport)
    let md = `# ${topic.title}\n\n`;
    md += topic.detail + '\n\n';
    if (qaList.length > 0) {
      md += `---\n\n## 📎 扩展讨论\n\n`;
      qaList.forEach((qa, i) => {
        md += `### 追问 ${i + 1}\n\n${qa.question}\n\n`;
        md += `> ${qa.answer}\n\n`;
      });
    }

    // ── Step 1: Split into segments — regular text vs mermaid blocks ──
    // Each segment: { type: 'markdown'|'mermaid', content: string }
    const segments = [];
    const mermaidRe = /```mermaid\s*\n([\s\S]*?)```/g;
    let lastIdx = 0;
    let match;
    while ((match = mermaidRe.exec(md)) !== null) {
      if (match.index > lastIdx) {
        segments.push({ type: 'markdown', content: md.slice(lastIdx, match.index) });
      }
      segments.push({ type: 'mermaid', content: match[1].trim() });
      lastIdx = mermaidRe.lastIndex;
    }
    if (lastIdx < md.length) {
      segments.push({ type: 'markdown', content: md.slice(lastIdx) });
    }

    // ── Step 2: Simple Markdown-to-HTML converter ──
    const mdToHtml = (text) => {
      // Escape HTML special chars
      let h = text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      // Headings
      h = h.replace(/^##### (.*$)/gm, '<h5>$1</h5>');
      h = h.replace(/^#### (.*$)/gm, '<h4>$1</h4>');
      h = h.replace(/^### (.*$)/gm, '<h3>$1</h3>');
      h = h.replace(/^## (.*$)/gm, '<h2>$1</h2>');
      h = h.replace(/^# (.*$)/gm, '<h1>$1</h1>');
      // Bold + italic
      h = h.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
      h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');
      // Inline code
      h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
      // Links
      h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
      // Horizontal rule
      h = h.replace(/^---$/gm, '<hr>');
      // Blockquote
      h = h.replace(/^> (.*$)/gm, '<blockquote>$1</blockquote>');
      // Unordered list items
      h = h.replace(/^- (.*$)/gm, '<li>$1</li>');
      // Ordered list items
      h = h.replace(/^\d+\. (.*$)/gm, '<li>$1</li>');
      // Wrap consecutive <li> in <ul>
      h = h.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
      // Paragraphs: double newline = new paragraph (skip block-level elements)
      h = h.replace(/\n\n/g, '</p><p>');
      // Wrap remaining in <p> if not already wrapped
      if (!h.startsWith('<h') && !h.startsWith('<p>') && !h.startsWith('<ul') && !h.startsWith('<blockquote') && !h.startsWith('<hr')) {
        h = '<p>' + h;
      }
      if (!h.endsWith('>')) {
        h = h + '</p>';
      }
      // Clean empty paragraphs
      h = h.replace(/<p><\/p>/g, '');
      return h;
    };

    // ── Step 3: Render all segments to HTML (mermaid → SVG) ──
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({
      startOnLoad: false,
      theme: 'neutral',
      securityLevel: 'strict',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    });

    let bodyHtml = '';
    for (const seg of segments) {
      if (seg.type === 'mermaid') {
        try {
          const id = 'm-export-' + Math.random().toString(36).slice(2, 9);
          const { svg: svgText } = await mermaid.render(id, seg.content);
          bodyHtml += `<div class="mermaid-svg">${svgText}</div>`;
        } catch {
          bodyHtml += `<pre class="mermaid-fallback">${seg.content}</pre>`;
        }
      } else {
        bodyHtml += mdToHtml(seg.content);
      }
    }

    // ── Step 4: Build self-contained HTML ──
    const title = topic.title.replace(/[/\\?%*:|"<>]/g, '_');
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 24px 20px; line-height: 1.8; color: #1e293b; background: #fff; }
  h1 { font-size: 24px; margin: 20px 0 10px; }
  h2 { font-size: 20px; margin: 16px 0 8px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
  h3 { font-size: 17px; margin: 12px 0 6px; }
  h4, h5 { font-size: 15px; margin: 10px 0 5px; }
  p { margin: 8px 0; }
  ul, ol { padding-left: 20px; margin: 8px 0; }
  li { margin: 3px 0; }
  code { padding: 2px 5px; background: #f1f5f9; border-radius: 3px; font-size: .9em; }
  pre { padding: 12px 16px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; overflow-x: auto; font-size: 13px; }
  pre.mermaid-fallback { background: #fef2f2; border-color: #fca5a5; color: #dc2626; }
  blockquote { margin: 10px 0; padding: 8px 14px; border-left: 3px solid #60a5fa; background: #f1f5f9; border-radius: 0 6px 6px 0; }
  table { width: 100%; border-collapse: collapse; margin: 10px 0; }
  th, td { padding: 6px 10px; border: 1px solid #e2e8f0; text-align: left; }
  th { background: #f1f5f9; font-weight: 600; }
  hr { margin: 20px 0; border: none; border-top: 1px solid #e2e8f0; }
  a { color: #2563eb; }
  .mermaid-svg { margin: 16px 0; display: flex; justify-content: center; overflow-x: auto; padding: 16px 8px; background: #fafafa; border: 1px solid #e2e8f0; border-radius: 6px; }
  .mermaid-svg svg { max-width: 100%; height: auto; }
  .qa-section { margin-top: 32px; border-top: 2px solid #e2e8f0; padding-top: 16px; }
  .qa-section h2 { color: #2563eb; }
  .qa-item { margin: 16px 0; }
  .qa-question { font-weight: 600; color: #1e293b; padding: 8px 12px; background: #eff6ff; border-radius: 6px; }
  .qa-answer { padding: 8px 12px 8px 16px; border-left: 3px solid #e2e8f0; margin-left: 4px; }
  .footer { margin-top: 32px; font-size: 12px; color: #94a3b8; text-align: center; border-top: 1px solid #e2e8f0; padding-top: 16px; }
</style>
</head>
<body>
${bodyHtml}
<div class="footer">由 Study Assistant 生成</div>
</body>
</html>`;

    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title}.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleRetry = () => {
    setError(null);
    setLocalDetail('');
    genTriggered.current = false;
    setGenerating(true);
    api.generateDetail(plan.id, topic.id).catch(() => {});
  };

  const handleDifficulty = async (level) => {
    if (difficultySaving) return;
    setDifficulty(level);
    setDifficultySaving(true);
    try {
      await api.updateTopic(plan.id, topic.id, { difficulty: level });
      const fresh = await api.getPlan(plan.id);
      onRefresh(fresh.plan);
    } catch { /* ignore */ }
    setDifficultySaving(false);
  };

  const handleComplete = async () => {
    // First check for embedded errors (challenge mode — always on)
    setRevealLoading(true);
    try {
      const recognized = foundErrorsInput.split(/[\n;；,，]+/).map(s => s.trim()).filter(Boolean);
      const result = await api.revealErrors(plan.id, topic.id, recognized);
      if (result.hasErrors && result.errors?.length > 0) {
        setRevealErrors(result);
        setRevealLoading(false);
        return; // Don't mark done yet — wait for user confirmation
      }
    } catch { /* silently continue if reveal fails */ }
    setRevealLoading(false);

    // No errors found or reveal failed — mark as done directly
    await doComplete();
  };

  const doComplete = async () => {
    try {
      await api.updateTopic(plan.id, topic.id, { done: true });
      const fresh = await api.getPlan(plan.id);
      onRefresh(fresh.plan);
      onBack();
    } catch {
      onBack();
    }
  };

  const handleDismissReveal = async () => {
    setRevealErrors(null);
    await doComplete();
  };

  // ─── Exercise Handlers ───
  const handleExerciseAnswer = (exerciseIndex, answer) => {
    setExerciseAnswers(prev => ({ ...prev, [exerciseIndex]: answer }));
  };

  const handleSubmitExercises = async () => {
    if (exerciseLoading || exercises.length === 0) return;
    setExerciseLoading(true);
    try {
      const answers = Object.entries(exerciseAnswers).map(([idx, answer]) => ({
        exerciseIndex: parseInt(idx),
        userAnswer: answer,
      }));
      const d = await api.submitExercises(plan.id, topic.id, answers);
      setExerciseResults(d.results);
      setSubmittedExercises(true);
      const fresh = await api.getPlan(plan.id);
      onRefresh(fresh.plan);
    } catch (err) {
      alert('提交失败: ' + err.message);
    } finally {
      setExerciseLoading(false);
    }
  };

  // ─── Review Mode Handlers ───
  const handleToggleReview = async () => {
    if (reviewContent) {
      setReviewMode(!reviewMode);
      return;
    }
    setReviewLoading(true);
    setReviewMode(true);
    try {
      const d = await api.generateReview(plan.id, topic.id);
      setReviewContent(d.review);
      const fresh = await api.getPlan(plan.id);
      onRefresh(fresh.plan);
    } catch (err) {
      setReviewError(err.message);
      setReviewMode(false);
    } finally {
      setReviewLoading(false);
    }
  };

  // Compute related topics data
  const prerequisites = topic?.prerequisites?.length
    ? topic.prerequisites.map(id => plan.topics.find(t => t.id === id)).filter(Boolean)
    : [];
  const childrenTopics = plan.topics.filter(t => t.parentId === topic?.id).sort((a, b) => a.order - b.order);
  const nextTopics = plan.topics.filter(t =>
    t.prerequisites?.includes(topic?.id)
  ).sort((a, b) => a.order - b.order);
  const relatedTopics = topic?.relatedTopics?.length
    ? topic.relatedTopics.map(id => plan.topics.find(t => t.id === id)).filter(Boolean)
    : [];

  // Handle navigation to a related topic
  const handleNavigateToTopic = (targetTopicId) => {
    onBack();
    if (onSelectTopic) onSelectTopic(targetTopicId);
  };

  // ─── Interactive Mode Handlers ───

  const handleStartInteractive = async (mode) => {
    if (interactiveBusyRef.current) return;
    interactiveBusyRef.current = true;
    setInteractiveMode(mode);
    setInteractiveSections([]);
    setStreamingContent('');
    setInteractiveFinished(false);
    setInteractiveLoading(true);
    try {
      let fullContent = '';
      let sessionData = null;
      await api.startInteractiveSSE(plan.id, topic.id, mode, (event) => {
        if (event.type === 'chunk') {
          fullContent += event.content;
          setStreamingContent(fullContent); // progressive typewriter effect
        } else if (event.type === 'pause') {
          // Section complete — push to sections, clear streaming
          setInteractiveSections(prev => [...prev, { content: fullContent }]);
          setStreamingContent('');
          fullContent = '';
        } else if (event.type === 'done') {
          if (fullContent && !sessionData) {
            // No pause happened — push as single section
            setInteractiveSections(prev => [...prev, { content: fullContent }]);
          }
          setStreamingContent('');
          sessionData = event.session;
          if (event.session?.stateMachine) {
            setInteractiveStateMachine(event.session.stateMachine);
          }
          if (event.finished) {
            setInteractiveFinished(true);
          }
        } else if (event.type === 'error') {
          setInteractiveSections(prev => [...prev, { content: '❌ ' + event.data }]);
        }
      });
    } catch (err) {
      setInteractiveSections([{ content: '❌ 启动失败: ' + err.message }]);
    } finally {
      setInteractiveLoading(false);
      interactiveBusyRef.current = false;
    }
  };

  const handleSendInteractiveFeedback = async () => {
    const feedback = interactiveInput.trim();
    if (!feedback || interactiveBusyRef.current) return;
    await handleContinueInteractive(feedback);
  };

  const handleQuickAction = async (action) => {
    if (interactiveBusyRef.current) return;
    await handleContinueInteractive(action);
  };

  const handleContinueInteractive = async (feedback) => {
    if (!interactiveMode || interactiveBusyRef.current) return;
    interactiveBusyRef.current = true;
    setInteractiveLoading(true);
    setInteractiveInput('');
    setStreamingContent('');
    try {
      let fullContent = '';
      await api.continueInteractiveSSE(plan.id, topic.id, interactiveMode, feedback, (event) => {
        if (event.type === 'chunk') {
          fullContent += event.content;
          setStreamingContent(fullContent);
        } else if (event.type === 'pause') {
          setInteractiveSections(prev => [...prev, { content: fullContent }]);
          setStreamingContent('');
          fullContent = '';
          if (event.session?.stateMachine) {
            setInteractiveStateMachine(event.session.stateMachine);
          }
        } else if (event.type === 'done') {
          if (fullContent) {
            setInteractiveSections(prev => [...prev, { content: fullContent }]);
          }
          setStreamingContent('');
          if (event.session?.stateMachine) {
            setInteractiveStateMachine(event.session.stateMachine);
          }
          if (event.finished) {
            setInteractiveFinished(true);
          }
        } else if (event.type === 'error') {
          setInteractiveSections(prev => [...prev, { content: '❌ ' + event.data }]);
        }
      });
    } catch (err) {
      setInteractiveSections(prev => [...prev, { content: '❌ 响应失败: ' + err.message }]);
    } finally {
      setInteractiveLoading(false);
      interactiveBusyRef.current = false;
    }
  };

  const handleExitInteractive = () => {
    setInteractiveMode(null);
    setInteractiveSections([]);
    setInteractiveFinished(false);
    setInteractiveInput('');
    setInteractiveStateMachine(null);
  };

  // ─── Voice Input Handler ───

  const handleVoiceInput = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('您的浏览器不支持语音输入，请使用 Chrome 或 Edge');
      return;
    }

    if (isRecording) {
      // Stop recording
      if (recognitionRef.current) {
        try { recognitionRef.current.stop(); } catch {}
      }
      setIsRecording(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = 'zh-CN';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    let finalTranscript = '';

    recognition.onresult = (event) => {
      // Only append FINAL results to avoid text duplication from interim callbacks
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0].transcript;
        }
      }
      // Always show the latest interim + final transcript in input
      const latestTranscript = Array.from(event.results)
        .map(r => r[0].transcript)
        .join('');
      setQaInput(latestTranscript);
    };

    recognition.onend = () => {
      setIsRecording(false);
      // Use the accumulated final transcript for auto-submit
      if (finalTranscript.trim()) {
        // Set input and immediately submit
        setQaInput(finalTranscript.trim());
        setTimeout(() => handleAsk(), 50);
      }
    };

    recognition.onerror = (event) => {
      console.error('Speech recognition error:', event.error);
      setIsRecording(false);
      if (event.error === 'not-allowed') {
        alert('语音输入需要麦克风权限，请在浏览器设置中允许');
      } else if (event.error === 'no-speech') {
        // Silent: no speech detected, user can try again
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsRecording(true);
  };

  return (
    <div className="topic-detail">
      <div className="topic-detail-header">
        <button className="btn btn-sm" onClick={onBack}>← 返回列表</button>
        <h2>{topic.title}</h2>
        {generating && <span className="generating-badge">⏳ 生成中...</span>}
        {error && <span className="error-badge">❌ 生成失败</span>}
        {localDetail && !error && !generating && (
          <button className="btn btn-sm" onClick={handleExport} title="导出为 Markdown">
            ⬇️ .md
          </button>
        )}
        {localDetail && !error && !generating && (
          <button className="btn btn-sm" onClick={handleExportHtml} title="导出为 HTML（含渲染后的 Mermaid 图表）">
            🌐 .html
          </button>
        )}
        {localDetail && !error && !generating && topic.done === false && (
          <button className="btn btn-sm" onClick={handleComplete} disabled={revealLoading} style={{ background: '#22c55e', color: 'white', borderColor: '#22c55e' }} title="标记为已学完并返回列表">
            {revealLoading ? '⏳ 检查中...' : '✅ 学完了'}
          </button>
        )}
        {localDetail && !error && !generating && topic.done && (
          <button className="btn btn-sm" onClick={handleToggleReview} style={{ background: reviewMode ? '#6366f1' : '#8b5cf6', color: 'white', borderColor: reviewMode ? '#6366f1' : '#8b5cf6' }} title="复习模式">
            {reviewLoading ? '⏳' : '🔄'} {reviewMode ? '返回讲解' : '复习'}
          </button>
        )}
        {/* Interactive mode buttons */}
        {!generating && localDetail && !error && !interactiveMode && (
          <>
            <button className="btn btn-sm interactive-btn stepwise-btn" onClick={() => handleStartInteractive('stepwise')} title="分段讲解，每部分等你反馈后再继续">
              📖 分段讲解
            </button>
            <button className="btn btn-sm interactive-btn realtime-btn" onClick={() => handleStartInteractive('realtime')} title="实时互动，更灵活的教学节奏">
              🎙️ 实时互动
            </button>
            <button className="btn btn-sm interactive-btn feynman-btn" onClick={() => handleStartInteractive('feynman')} title="你讲AI听，通过费曼学习法检验理解">
              🧑‍🏫 费曼学习法
            </button>
          </>
        )}
        {interactiveMode && (
          <button className="btn btn-sm" onClick={handleExitInteractive} style={{ background: '#ef4444', color: 'white', borderColor: '#ef4444' }}>
            ✕ 退出互动
          </button>
        )}
      </div>

      <div className="topic-detail-body">
        {/* Relationship section (shown when not generating) */}
        {!generating && (prerequisites.length > 0 || childrenTopics.length > 0 || nextTopics.length > 0 || relatedTopics.length > 0) && (
          <div className="topic-relations">
            {prerequisites.length > 0 && (
              <div className="relation-section">
                <span className="relation-label">📖 前置知识：</span>
                {prerequisites.map(p => (
                  <span key={p.id} className="relation-chip" onClick={() => handleNavigateToTopic(p.id)} title="跳转到该知识点">
                    {p.title} {p.done ? '✅' : '⏳'}
                  </span>
                ))}
              </div>
            )}
            {childrenTopics.length > 0 && (
              <div className="relation-section">
                <span className="relation-label">📂 子知识点：</span>
                {childrenTopics.map(c => (
                  <span key={c.id} className="relation-chip" onClick={() => handleNavigateToTopic(c.id)} title="跳转到该知识点">
                    {c.title} {c.done ? '✅' : '⏳'}
                  </span>
                ))}
              </div>
            )}
            {nextTopics.length > 0 && (
              <div className="relation-section">
                <span className="relation-label">➡️ 后续知识点：</span>
                {nextTopics.map(n => (
                  <span key={n.id} className="relation-chip" onClick={() => handleNavigateToTopic(n.id)} title="跳转到该知识点">
                    {n.title} {n.done ? '✅' : '⏳'}
                  </span>
                ))}
              </div>
            )}
            {relatedTopics.length > 0 && (
              <div className="relation-section">
                <span className="relation-label">🔗 相关知识：</span>
                {relatedTopics.map(r => (
                  <span key={r.id} className="relation-chip" onClick={() => handleNavigateToTopic(r.id)} title="跳转到该知识点">
                    {r.title} {r.done ? '✅' : '⏳'}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
        {revealLoading && (
          <div className="reveal-overlay">
            <div className="reveal-modal">
              <div className="spinner-sm" />
              <p>正在检查讲解内容中的潜在错误...</p>
            </div>
          </div>
        )}
        {revealErrors && (
          <div className="reveal-overlay">
            <div className="reveal-modal">
              <div className="reveal-modal-header">
                🔍 等一下！AI 在内容中埋了挑战
              </div>
              <p style={{ margin: '12px 0', color: '#666', fontSize: '14px' }}>
                这份讲解中包含了一些微妙的错误，用来考验你是否真正理解了。
                你没发现的错误有：
              </p>
              {revealErrors.errors.map((err, i) => (
                <div key={i} className={"reveal-error-item" + (err.recognized ? " reveal-error-recognized" : "")}>
                  <div className="reveal-error-location">
                    {err.recognized ? "✅ 你发现了：" : "📍 "}{err.location || "位置未知"}
                  </div>
                  <div className="reveal-error-desc">{err.description}</div>
                  <div className="reveal-error-correction">✅ 正确版本：{err.correction}</div>
                  {err.misconception && (
                    <div className="reveal-error-misconception">🧠 针对的误区：{err.misconception}</div>
                  )}
                  <div className="reveal-error-tags">
                    {(err.errorType || err.type) && (
                      <span className="reveal-error-type">{ERROR_TYPE_LABELS[err.errorType] || err.errorType || err.type}</span>
                    )}
                    {err.bloomLevel && <span className="reveal-error-bloom">认知层次：{err.bloomLevel}</span>}
                  </div>
                </div>
              ))}
              <button className="btn btn-primary" onClick={handleDismissReveal} style={{ marginTop: '16px', width: '100%' }}>
                我知道了，标记完成
              </button>
            </div>
          </div>
        )}
        {/* Generating — show spinner + any intermediate content */}
        {generating && !localDetail && (
          <div className="generating-placeholder">
            <div className="spinner" />
            <p>AI 正在为您生成「{topic.title}」的详细讲解...</p>
            <p className="hint">首次生成可能需要 30 秒到 1 分钟</p>
          </div>
        )}

        {/* Error — show error + retry */}
        {error && (
          <div className="error-state">
            <p>❌ {error}</p>
            <button className="btn btn-primary" onClick={handleRetry}>重试</button>
          </div>
        )}

        {/* Interactive Mode Content */}
        {interactiveMode && (
          <div className="topic-content">
            <div className="interactive-mode-header">
              <span className="interactive-mode-badge">{interactiveMode === 'stepwise' ? '📖 分段讲解' : interactiveMode === 'feynman' ? '🧑‍🏫 费曼学习法' : '🎙️ 实时互动'}</span>
              {interactiveLoading && <span className="typing-text">导师正在思考...</span>}
              {interactiveFinished && <span className="interactive-finished-badge">✅ 讲解完成</span>}
            </div>

            {/* Dynamic progress counter for stepwise mode */}
            {interactiveMode === 'stepwise' && interactiveStateMachine && (
              <div className="sm-progress-bar">
                <div className="sm-progress-text">
                  {interactiveStateMachine.completedSteps > 0
                    ? `✅ 已完成 ${interactiveStateMachine.completedSteps} 部分`
                    : '📖 第 1 部分'}
                </div>
              </div>
            )}

            <div className="interactive-sections">
              {interactiveSections.map((section, i) => (
                <div key={i} className="interactive-section">
                  <div className="interactive-section-number">第 {i + 1} 部分</div>
                  <ContentArea content={section.content} />
                </div>
              ))}
            </div>

            {/* Live streaming content (typewriter effect) */}
            {streamingContent && (
              <div className="interactive-section streaming-section">
                <div className="interactive-section-number">⏳ 正在生成...</div>
                <ContentArea content={streamingContent} />
              </div>
            )}

            {interactiveLoading && (
              <div className="interactive-loading">
                <div className="spinner-sm" />
                <span>{streamingContent ? '正在生成内容...' : '导师正在思考...'}</span>
              </div>
            )}

            {!interactiveLoading && !interactiveFinished && interactiveSections.length > 0 && (
              <div className="interactive-actions">
                <p className="interactive-prompt">💬 你的回应是什么？</p>
                <div className="interactive-quick-buttons">
                  <button className="btn btn-sm interactive-quick-btn" onClick={() => handleQuickAction('继续')}>
                    ✅ 继续
                  </button>
                  <button className="btn btn-sm interactive-quick-btn" onClick={() => handleQuickAction('不太懂，详细解释')}>
                    🤔 不太懂
                  </button>
                  <button className="btn btn-sm interactive-quick-btn" onClick={() => handleQuickAction('给我举个例子')}>
                    💡 举例
                  </button>
                  <button className="btn btn-sm interactive-quick-btn" onClick={() => handleQuickAction('和前面讲的有什么关系？')}>
                    🔗 关联
                  </button>
                  {interactiveMode === 'realtime' && (
                    <button className="btn btn-sm interactive-quick-btn" onClick={() => handleQuickAction('换个角度解释')}>
                      🔄 换角度
                    </button>
                  )}
                </div>
                <div className="interactive-input-area">
                  <textarea
                    ref={interactiveInputRef}
                    value={interactiveInput}
                    onChange={e => setInteractiveInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSendInteractiveFeedback();
                      }
                    }}
                    placeholder="输入你的问题或反馈...（Enter 发送）"
                    rows={2}
                  />
                  {voiceSupported && (
                    <button
                      type="button"
                      className={"voice-btn" + (isRecording ? ' recording' : '')}
                      onClick={handleVoiceInput}
                      disabled={interactiveLoading}
                      title={isRecording ? '点击停止录音' : '语音输入（点击后说话）'}
                    >
                      🎤
                    </button>
                  )}
                  <button className="btn btn-primary interactive-send-btn" onClick={handleSendInteractiveFeedback} disabled={!interactiveInput.trim()}>
                    发送
                  </button>
                </div>
              </div>
            )}

            {interactiveFinished && (
              <div className="interactive-finished-actions">
                <p>🎉 互动讲解已完成！你可以继续提问或退出互动模式。</p>
                <div className="interactive-finished-buttons">
                  <button className="btn btn-sm" onClick={() => handleQuickAction('我还有问题想问')}>
                    💬 继续提问
                  </button>
                  <button className="btn btn-sm" onClick={handleExitInteractive}>
                    ✅ 结束互动
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Content + inline Q&A */}
        {localDetail && !error && !interactiveMode && (
          <div className="topic-content">
            {/* Generated illustration */}
            <div className="topic-illustration-section">
              {topic.imageUrl ? (
                <div className="topic-illustration">
                  <div className="topic-illustration-header">
                    <span>📊 知识点配图</span>
                    <button
                      className="btn-tiny"
                      onClick={() => handleGenerateImage(topic.id)}
                      disabled={generating}
                      title="重新生成配图"
                    >🔄</button>
                  </div>
                  <img src={topic.imageUrl} alt={topic.title} className="topic-illustration-img" />
                </div>
              ) : localDetail && !generating && settings.imageApiKey && (
                <div className="topic-illustration-placeholder">
                  <button
                    className="btn btn-sm"
                    onClick={() => handleGenerateImage(topic.id)}
                  >
                    🎨 生成配图
                  </button>
                  <span className="field-hint">使用硅基流动 AI 为知识点生成插图</span>
                </div>
              )}
            </div>
            <ContentArea content={localDetail} />
            {generating && <div className="streaming-indicator">⏳ 继续生成中...</div>}

            {/* Chat panel for Q&A (DS-web style) */}
            <div className="chat-panel">
              <div className="chat-panel-header">
                <h2>📎 扩展讨论</h2>
                {qaList.length > 0 && <span className="chat-count">{qaList.length} 轮</span>}
              </div>
              {qaList.length >= 2 && (
                <div className="chat-round-nav">
                  {qaList.map((qa, i) => (
                    <div key={i} className="chat-round-chip-wrapper">
                      <button
                        className="chat-round-chip"
                        onClick={() => scrollToRound(i)}
                        onMouseEnter={() => setHoveredRound(i)}
                        onMouseLeave={() => setHoveredRound(null)}
                        title={qa.question}
                      >
                        {i + 1}
                      </button>
                      {hoveredRound === i && (
                        <div className="chat-round-preview">
                          <div className="chat-round-preview-label">追问 {i + 1}</div>
                          <div className="chat-round-preview-text">{qa.question}</div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="chat-messages" ref={chatPanelRef}>
                <QaMessages qaList={qaList} />
              </div>
              <div className="chat-input">
                <form onSubmit={e => { e.preventDefault(); }}>
                  <textarea
                    ref={qaInputRef}
                    value={qaInput}
                    onChange={e => setQaInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleAsk();
                      }
                    }}
                    placeholder="输入你的追问...（Shift+Enter 换行，Enter 发送）"
                    disabled={qaLoading}
                    rows={1}
                    onInput={e => {
                      // Auto-resize textarea
                      e.target.style.height = 'auto';
                      e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
                    }}
                  />
                  <button type="button" className="chat-send-btn" onClick={handleAsk} disabled={!qaInput.trim() || qaLoading}>
                    {qaLoading ? <span className="typing-text">思考中...</span> : '➤'}
                  </button>
                </form>
              </div>
            </div>

            {/* ─── Review Mode Content ─── */}
            {!generating && reviewMode && reviewContent && !reviewLoading && (
              <div className="review-section">
                <hr />
                <div className="review-content">
                  <ContentArea content={reviewContent} />
                </div>
              </div>
            )}
            {reviewLoading && (
              <div className="generating-placeholder" style={{ padding: '16px' }}>
                <div className="spinner-sm" />
                <p>AI 正在生成复习内容，针对你的薄弱点进行巩固...</p>
              </div>
            )}
            {/* ─── Exercise Section ─── */}
            {!generating && !reviewMode && exercises.length > 0 && !submittedExercises && (
              <div className="exercise-section">
                <hr />
                <h3>📝 练习题</h3>
                {exercises.map((ex, i) => (
                  <div key={i} className="exercise-card">
                    <div className="exercise-header">
                      <span className="exercise-number">练习题 {i + 1}</span>
                      <span className="exercise-type-badge">{ex.type === 'choice' ? '选择题' : '简答题'}</span>
                      {ex.conceptTag && <span className="exercise-concept-tag">{ex.conceptTag}</span>}
                    </div>
                    <p className="exercise-question">{ex.question}</p>
                    {ex.type === 'choice' && ex.options && ex.options.length > 0 ? (
                      <div className="exercise-options">
                        {ex.options.map((opt, oi) => (
                          <label key={oi} className={"exercise-option" + (exerciseAnswers[i] === opt.charAt(0) ? ' selected' : '')}>
                            <input
                              type="radio"
                              name={"ex-" + i}
                              value={opt.charAt(0)}
                              checked={exerciseAnswers[i] === opt.charAt(0)}
                              onChange={() => handleExerciseAnswer(i, opt.charAt(0))}
                            />
                            <span>{opt}</span>
                          </label>
                        ))}
                      </div>
                    ) : (
                      <textarea
                        className="exercise-text-input"
                        placeholder="输入你的答案..."
                        value={exerciseAnswers[i] || ''}
                        onChange={e => handleExerciseAnswer(i, e.target.value)}
                        rows={3}
                      />
                    )}
                  </div>
                ))}
                <button className="btn btn-primary" onClick={handleSubmitExercises} disabled={exerciseLoading || Object.keys(exerciseAnswers).length === 0}>
                  {exerciseLoading ? '⏳ 批改中...' : '📤 提交答案'}
                </button>
              </div>
            )}
            {/* ─── Exercise Results ─── */}
            {!generating && !reviewMode && submittedExercises && exerciseResults && (
              <div className="exercise-results">
                <hr />
                <h3>📊 练习结果</h3>
                {exerciseResults.map((res, i) => (
                  <div key={i} className={"exercise-result-card " + (res.correct ? 'correct' : 'wrong')}>
                    <div className="exercise-result-header">
                      <span className="exercise-result-icon">{res.correct ? '✅' : '❌'}</span>
                      <span className="exercise-result-label">练习题 {i + 1}</span>
                    </div>
                    <p className="exercise-result-detail">
                      <strong>你的答案：</strong>{res.userAnswer || '未作答'}
                      {!res.correct && <><br /><strong>正确答案：</strong>{res.correctAnswer}</>}
                    </p>
                    {res.explanation && <p className="exercise-explanation">💡 {res.explanation}</p>}
                  </div>
                ))}
              </div>
            )}

            {/* Difficulty self-rating */}
            {!generating && (
              <div className="difficulty-rating">
                <hr />
                <p className="difficulty-label">这个知识点对你来说？</p>
                <div className="difficulty-buttons">
                  <button
                    className={'diff-btn' + (difficulty === 'easy' ? ' active easy' : '')}
                    onClick={() => handleDifficulty('easy')}
                    disabled={difficultySaving}
                  >🟢 简单</button>
                  <button
                    className={'diff-btn' + (difficulty === 'medium' ? ' active medium' : '')}
                    onClick={() => handleDifficulty('medium')}
                    disabled={difficultySaving}
                  >🟡 适中</button>
                  <button
                    className={'diff-btn' + (difficulty === 'hard' ? ' active hard' : '')}
                    onClick={() => handleDifficulty('hard')}
                    disabled={difficultySaving}
                  >🔴 困难</button>
                </div>
              </div>
            )}

            {/* Self-report: which errors did you catch? (feeds challenge-mode recognition) */}
            <div className="found-errors-box">
              <label className="found-errors-label" htmlFor="found-errors-input">
                🔎 你在讲解中发现了哪些错误？（选填，每行一条，点“学完了”后会核对）
              </label>
              <textarea
                id="found-errors-input"
                className="found-errors-input"
                rows={2}
                placeholder="例如：边界条件应该是 <= 而不是 <"
                value={foundErrorsInput}
                onChange={(e) => setFoundErrorsInput(e.target.value)}
              />
            </div>
            {/* Mark complete & go back */}
            <div className="topic-complete-bar">
              <button className="btn-complete" onClick={handleComplete} disabled={revealLoading} title="标记为已学完并返回列表">
                {revealLoading ? '⏳ 检查错误中...' : '✅ 学完了，返回列表'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
