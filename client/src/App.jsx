import { useState, useEffect, useCallback, useRef } from 'react'
import { Routes, Route, useNavigate, useLocation, Navigate, useParams } from 'react-router-dom'
import { BookOpen, User, Settings, ArrowLeft } from 'lucide-react'
import PlanList from './components/PlanList'
import PlanView from './components/PlanView'
import TopicDetail from './components/TopicDetail'
import UserProfile from './pages/UserProfile'
import SettingsModal from './components/SettingsModal'
import ThemeSwitcher from './components/ThemeSwitcher'
import api from './api'
import { PlanProvider, usePlan } from '#/lib/plan-context.jsx'

function loadApiSettings() {
  try {
    const raw = localStorage.getItem('textbook-maker-settings')
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

function PlanViewWrapper({ onGenerate }) {
  const { planId } = useParams()
  const { currentPlan, setCurrentPlan, refreshPlan } = usePlan()
  const planPollRef = useRef(null)

  useEffect(() => {
    if (!planId) { setCurrentPlan(null); return; }
    refreshPlan(planId)
    planPollRef.current = setInterval(() => refreshPlan(planId), 5000)
    return () => { clearInterval(planPollRef.current); planPollRef.current = null }
  }, [planId, refreshPlan, setCurrentPlan])

  const handleAddTopics = useCallback(async (titles) => {
    if (!planId) return
    const d = await api.addTopics(planId, titles)
    setCurrentPlan(d.plan)
  }, [planId, setCurrentPlan])

  const handleRemoveTopic = useCallback(async (topicId) => {
    if (!planId) return
    const d = await api.removeTopic(planId, topicId)
    setCurrentPlan(d.plan)
  }, [planId, setCurrentPlan])

  return (
    <PlanView
      plan={currentPlan}
      onAddTopics={handleAddTopics}
      onRemoveTopic={handleRemoveTopic}
      onSelectTopic={(topicId) => onGenerate(topicId)}
      onGenerate={onGenerate}
    />
  )
}

function TopicDetailWrapper({ onSelectTopic }) {
  const { planId, topicId } = useParams()
  const { currentPlan, setCurrentPlan, refreshPlan } = usePlan()
  const navigate = useNavigate()

  const topic = currentPlan?.topics.find(t => t.id === topicId) || null

  const handleBack = useCallback(() => {
    navigate(`/plan/${planId}`, { replace: true })
  }, [navigate, planId])

  const handleRefresh = useCallback((plan) => {
    setCurrentPlan(plan)
  }, [setCurrentPlan])

  if (!currentPlan) {
    return <div className='flex items-center justify-center py-16 text-muted-foreground text-sm'>加载中...</div>
  }

  return (
    <TopicDetail
      plan={currentPlan}
      topic={topic}
      onBack={handleBack}
      onRefresh={handleRefresh}
      onSelectTopic={onSelectTopic}
    />
  )
}

function AppContent() {
  const navigate = useNavigate()
  const location = useLocation()
  const { plans, setPlans, setCurrentPlan, refreshPlans } = usePlan()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [hasApiKey, setHasApiKey] = useState(!!loadApiSettings().apiKey)

  const showBackToList = location.pathname.startsWith('/plan/')
  const showProfileInHeader = location.pathname !== '/profile'

  const goToList = useCallback(() => {
    setCurrentPlan(null)
    navigate('/')
  }, [navigate, setCurrentPlan])

  const handleShowProfile = () => navigate('/profile')
  const handleHideProfile = () => navigate('/')

  const handleSettingsSave = (settings) => { setHasApiKey(!!settings.apiKey) }

  const handleCreatePlan = async (name) => {
    const d = await api.createPlan(name)
    setPlans(prev => [d.plan, ...prev])
    navigate(`/plan/${d.plan.id}`)
  }

  const handleDeletePlan = async (id) => {
    await api.deletePlan(id)
    if (location.pathname === `/plan/${id}`) goToList()
    refreshPlans()
  }

  const handleImportPlan = async (text) => {
    const d = await api.importPlan(text)
    setPlans(prev => [d.plan, ...prev])
    navigate(`/plan/${d.plan.id}`)
  }

  const handleGenerate = (topicId) => {
    const match = location.pathname.match(/^\/plan\/([^/]+)/)
    if (match) navigate(`/plan/${match[1]}/topic/${topicId}`)
  }

  return (
    <div className='flex flex-col h-screen bg-background'>
      <header className='flex items-center justify-between border-b bg-card px-6 py-3'>
        <div className='flex items-center gap-2'>
          <BookOpen className='h-5 w-5 text-primary' />
          <h1 className='text-base font-semibold'>知识点学习助手</h1>
          <span className='hidden sm:inline text-xs text-muted-foreground'>逐个知识点深入，AI 自适应讲解</span>
        </div>
        <div className='flex items-center gap-2'>
          {!hasApiKey && <span className='text-xs text-destructive'>请先设置 API Key</span>}
          {showProfileInHeader && (
            <button onClick={handleShowProfile} className='inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm hover:bg-accent transition-colors' title='学习画像'>
              <User className='h-4 w-4' /><span className='hidden sm:inline'>画像</span>
            </button>
          )}
          <ThemeSwitcher />
          <button onClick={() => setSettingsOpen(true)} className='rounded-md p-1.5 hover:bg-accent transition-colors' title='API 设置'>
            <Settings className='h-4 w-4' />
          </button>
          {showBackToList && (
            <button onClick={goToList} className='inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm hover:bg-accent transition-colors'>
              <ArrowLeft className='h-4 w-4' />返回
            </button>
          )}
          {location.pathname === '/profile' && (
            <button onClick={handleHideProfile} className='inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm hover:bg-accent transition-colors'>
              <ArrowLeft className='h-4 w-4' />返回
            </button>
          )}
        </div>
      </header>

      <main className='flex-1 overflow-auto flex justify-center'>
        <Routes>
          <Route path="/" element={
            <PlanList
              plans={plans}
              onCreate={handleCreatePlan}
              onImport={handleImportPlan}
              onSelect={(id) => navigate(`/plan/${id}`)}
              onDelete={handleDeletePlan}
            />
          } />
          <Route path="/plan/:planId" element={
            <PlanViewWrapper onGenerate={handleGenerate} />
          } />
          <Route path="/plan/:planId/topic/:topicId" element={
            <TopicDetailWrapper
              onSelectTopic={(id) => {
                const match = location.pathname.match(/^\/plan\/([^/]+)/)
                if (match) navigate(`/plan/${match[1]}/topic/${id}`, { replace: true })
              }}
            />
          } />
          <Route path="/profile" element={
            <UserProfile onBack={() => navigate('/')} />
          } />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSave={handleSettingsSave}
      />
    </div>
  )
}

export default function App() {
  return (
    <PlanProvider>
      <AppContent />
    </PlanProvider>
  )
}
