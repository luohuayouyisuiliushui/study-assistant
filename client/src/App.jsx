import { useState, useEffect, useCallback, useRef } from 'react';
import PlanList from './components/PlanList';
import PlanView from './components/PlanView';
import TopicDetail from './components/TopicDetail';
import UserProfile from './pages/UserProfile';
import SettingsModal from './components/SettingsModal';
import api from './api';

function loadApiSettings() {
  try {
    const raw = localStorage.getItem('textbook-maker-settings');
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export default function App() {
  const [plans, setPlans] = useState([]);
  const [currentPlanId, setCurrentPlanId] = useState(null);
  const [currentPlan, setCurrentPlan] = useState(null);
  const [activeTopicId, setActiveTopicId] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(!!loadApiSettings().apiKey);
  const [showProfile, setShowProfile] = useState(false);
  const planPollRef = useRef(null);

  // Load plans
  const refreshPlans = useCallback(async () => {
    try { const d = await api.listPlans(); setPlans(d.plans); }
    catch { /* ignore */ }
  }, []);
  useEffect(() => { refreshPlans(); }, [refreshPlans]);

  // Refresh plans when restored from trash (custom event from PlanList)
  useEffect(() => {
    const handler = () => refreshPlans();
    window.addEventListener('plan-restored', handler);
    return () => window.removeEventListener('plan-restored', handler);
  }, [refreshPlans]);

  // Load current plan (auto-refresh for generation progress)
  useEffect(() => {
    if (!currentPlanId) { setCurrentPlan(null); return; }
    let cancelled = false;
    const load = async () => {
      try {
        const d = await api.getPlan(currentPlanId);
        if (!cancelled) setCurrentPlan(d.plan);
      } catch {
        if (!cancelled) {
          setCurrentPlan(null);
          setActiveTopicId(null);
        }
      }
    };
    load();
    planPollRef.current = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(planPollRef.current); planPollRef.current = null; };
  }, [currentPlanId]);

  const goToList = useCallback(() => {
    setCurrentPlanId(null);
    setActiveTopicId(null);
    if (planPollRef.current) {
      clearInterval(planPollRef.current);
      planPollRef.current = null;
    }
  }, []);

  const handleSettingsSave = (settings) => {
    setHasApiKey(!!settings.apiKey);
  };

  const handleCreatePlan = async (name) => {
    const d = await api.createPlan(name);
    setPlans(prev => [d.plan, ...prev]);
    setCurrentPlanId(d.plan.id);
    setShowProfile(false);
  };

  const handleDeletePlan = async (id) => {
    await api.deletePlan(id);
    if (currentPlanId === id) goToList();
    refreshPlans();
  };

  const handleImportPlan = async (text) => {
    const d = await api.importPlan(text);
    setPlans(prev => [d.plan, ...prev]);
    setCurrentPlanId(d.plan.id);
    setShowProfile(false);
  };

  const handleAddTopics = async (titles) => {
    if (!currentPlanId) return;
    const d = await api.addTopics(currentPlanId, titles);
    setCurrentPlan(d.plan);
  };

  const handleRemoveTopic = async (topicId) => {
    if (!currentPlanId) return;
    const d = await api.removeTopic(currentPlanId, topicId);
    setCurrentPlan(d.plan);
    if (activeTopicId === topicId) setActiveTopicId(null);
  };

  const handleGenerate = (topicId) => {
    if (!currentPlanId) return;
    setActiveTopicId(topicId);
  };

  const activeTopic = currentPlan?.topics.find(t => t.id === activeTopicId) || null;

  const handleShowProfile = () => {
    setShowProfile(true);
  };

  const handleHideProfile = () => {
    setShowProfile(false);
  };

  // Determine header and navigation context
  const showProfileInHeader = !showProfile;
  const showBackToList = currentPlanId && !showProfile;

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">
          <h1>📖 知识点学习助手</h1>
          <span className="subtitle">逐个知识点深入，AI 自适应讲解</span>
        </div>
        <div className="header-actions">
          {!hasApiKey && <span className="no-key-warning">⚙️ 请先设置 API Key</span>}
          {showProfileInHeader && (
            <button className="btn btn-sm" onClick={handleShowProfile} title="查看跨计划学习画像">
              👤 画像
            </button>
          )}
          <button className="btn btn-icon" onClick={() => setSettingsOpen(true)} title="API 设置">
            ⚙️
          </button>
          {showBackToList && (
            <button className="btn btn-sm" onClick={goToList}>← 返回列表</button>
          )}
          {showProfile && (
            <button className="btn btn-sm" onClick={handleHideProfile}>← 返回</button>
          )}
        </div>
      </header>

      <main className="app-main">
        {showProfile ? (
          <UserProfile onBack={handleHideProfile} />
        ) : !currentPlanId ? (
          <PlanList
            plans={plans}
            onCreate={handleCreatePlan}
            onImport={handleImportPlan}
            onSelect={(id) => { setCurrentPlanId(id); }}
            onDelete={handleDeletePlan}
          />
        ) : !activeTopic ? (
          <PlanView
            plan={currentPlan}
            onAddTopics={handleAddTopics}
            onRemoveTopic={handleRemoveTopic}
            onSelectTopic={(id) => setActiveTopicId(id)}
            onGenerate={handleGenerate}
          />
        ) : (
          <TopicDetail
            plan={currentPlan}
            topic={activeTopic}
            onBack={() => setActiveTopicId(null)}
            onRefresh={(plan) => setCurrentPlan(plan)}
            onSelectTopic={(id) => setActiveTopicId(id)}
          />
        )}
      </main>

      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSave={handleSettingsSave}
      />
    </div>
  );
}
