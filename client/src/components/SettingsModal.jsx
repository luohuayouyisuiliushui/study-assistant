import { useState } from 'react';
import api from '../api';
import { Button } from '#/components/ui/button';
import { Input } from '#/components/ui/input';
import { Label } from '#/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from '#/components/ui/dialog';
import { Settings, Eye, EyeOff, Loader2, CheckCircle2, XCircle, AlertCircle, Sparkles, DollarSign } from 'lucide-react';
import { Separator } from '#/components/ui/separator';
import { loadSettings, saveSettings, ROUTING_MODES } from '#/lib/settings-storage';

export default function SettingsModal({ isOpen, onClose, onSave }) {
  const saved = loadSettings();

  // Quality channel
  const [apiKey, setApiKey] = useState(saved.apiKey || '');
  const [baseURL, setBaseURL] = useState(saved.baseURL || 'https://api.openai.com/v1');
  const [model, setModel] = useState(saved.model || 'gpt-4o-mini');
  const [showKey, setShowKey] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);

  // Economy channel
  const [economyApiKey, setEconomyApiKey] = useState(saved.economyApiKey || '');
  const [economyBaseURL, setEconomyBaseURL] = useState(saved.economyBaseURL || '');
  const [economyModel, setEconomyModel] = useState(saved.economyModel || '');
  const [showEconomyKey, setShowEconomyKey] = useState(false);
  const [economyTestResult, setEconomyTestResult] = useState(null);
  const [economyTesting, setEconomyTesting] = useState(false);

  // Image generation
  const [imageApiKey, setImageApiKey] = useState(saved.imageApiKey || '');
  const [imageBaseUrl, setImageBaseUrl] = useState(saved.imageBaseUrl || 'https://api.siliconflow.cn/v1');
  const [imageModel, setImageModel] = useState(saved.imageModel || 'black-forest-labs/FLUX.1-pro');
  const [showImageKey, setShowImageKey] = useState(false);

  // Routing mode
  const [routingMode, setRoutingMode] = useState(saved.routingMode || ROUTING_MODES.BALANCED);

  // Explanation style preference
  const [explainStyle, setExplainStyle] = useState(saved.explainStyle || 'colloquial');

  // Server-side persistence
  const [saveToServer, setSaveToServer] = useState(false);
  const [savingServer, setSavingServer] = useState(false);
  const [serverSaveResult, setServerSaveResult] = useState(null);

  const handleTestConnection = async () => {
    if (!apiKey) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.testConnection(apiKey, baseURL, model);
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, error: err.message });
    } finally { setTesting(false); }
  };

  const handleTestEconomyConnection = async () => {
    if (!economyApiKey) return;
    setEconomyTesting(true);
    setEconomyTestResult(null);
    try {
      const result = await api.testConnection(economyApiKey, economyBaseURL || baseURL, economyModel || model);
      setEconomyTestResult(result);
    } catch (err) {
      setEconomyTestResult({ ok: false, error: err.message });
    } finally { setEconomyTesting(false); }
  };

  const handleSave = async () => {
    const settings = {
      apiKey, baseURL, model,
      economyApiKey, economyBaseURL, economyModel,
      imageApiKey, imageBaseUrl, imageModel,
      routingMode,
      explainStyle,
    };
    saveSettings(settings);

    if (saveToServer && apiKey) {
      setSavingServer(true);
      setServerSaveResult(null);
      try {
        await api.saveEnvKey(apiKey, baseURL, model);
        setServerSaveResult('ok');
      } catch (err) {
        setServerSaveResult(err.message);
      } finally {
        setSavingServer(false);
      }
    }

    onSave(settings);
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className='max-w-lg max-h-[90vh] overflow-y-auto'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2'><Settings className='h-5 w-5' />API 设置</DialogTitle>
        </DialogHeader>
        <DialogClose onClick={onClose} />

        <form className='flex flex-col gap-6' onSubmit={e => { e.preventDefault(); handleSave(); }}>

          <div className='flex items-start gap-2.5 rounded-lg border border-yellow-200 bg-yellow-50/60 px-3.5 py-2.5 text-xs text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950/60 dark:text-yellow-200 mb-6'>
            <AlertCircle className='h-4 w-4 mt-0.5 shrink-0' />
            <span>API Key 保存在浏览器本地。建议仅在个人设备使用，或配置服务端 <code className='bg-yellow-100 dark:bg-yellow-900 px-1 rounded'>.env</code> 环境变量。</span>
          </div>

          <div className='flex flex-col gap-6'>

            {/*
             * ─── Quality Channel ───
             */}
            <div className='flex flex-col gap-4'>
              <h3 className='text-sm font-semibold text-foreground flex items-center gap-1.5'>
                <Sparkles className='h-4 w-4 text-blue-500' />高质量通道
                <span className='text-xs font-normal text-muted-foreground'>（主通道 · 必填）</span>
              </h3>
              <p className='text-xs text-muted-foreground -mt-2'>用于资料导入、Detail 生成、学习分析、试卷生成等高价值任务。兼容旧版设置。</p>

              <div className='flex flex-col gap-1.5'>
                <Label>API Key <span className='text-destructive'>*</span></Label>
                <div className='relative'>
                  <Input type={showKey ? 'text' : 'password'} value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder='sk-...' className='pr-8' />
                  <button onClick={() => setShowKey(!showKey)} className='absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground' type='button'>
                    {showKey ? <EyeOff className='h-4 w-4' /> : <Eye className='h-4 w-4' />}
                  </button>
                </div>
              </div>

              <div className='flex flex-col gap-1.5'>
                <Label>API Base URL</Label>
                <Input type='text' value={baseURL} onChange={e => setBaseURL(e.target.value)} placeholder='https://api.openai.com/v1' />
              </div>

              <div className='flex flex-col gap-1.5'>
                <Label>模型</Label>
                <Input type='text' value={model} onChange={e => setModel(e.target.value)} placeholder='gpt-4o-mini' />
              </div>
            </div>

            <Separator className='my-2' />

            {/*
             * ─── Economy Channel ───
             */}
            <div className='flex flex-col gap-4'>
              <h3 className='text-sm font-semibold text-foreground flex items-center gap-1.5'>
                <DollarSign className='h-4 w-4 text-green-500' />低成本通道
                <span className='text-xs font-normal text-muted-foreground'>（可选）</span>
              </h3>
              <p className='text-xs text-muted-foreground -mt-2'>用于追问、互动教学、复习生成、练习批改等高频任务。未配置时自动回退使用高质量通道。</p>

              <div className='flex flex-col gap-1.5'>
                <Label>低成本 API Key</Label>
                <div className='relative'>
                  <Input type={showEconomyKey ? 'text' : 'password'} value={economyApiKey} onChange={e => setEconomyApiKey(e.target.value)} placeholder='sk-...' className='pr-8' />
                  <button onClick={() => setShowEconomyKey(!showEconomyKey)} className='absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground' type='button'>
                    {showEconomyKey ? <EyeOff className='h-4 w-4' /> : <Eye className='h-4 w-4' />}
                  </button>
                </div>
              </div>

              <div className='flex flex-col gap-1.5'>
                <Label>低成本 Base URL</Label>
                <Input type='text' value={economyBaseURL} onChange={e => setEconomyBaseURL(e.target.value)} placeholder='留空则使用高质量通道的 Base URL' />
              </div>

              <div className='flex flex-col gap-1.5'>
                <Label>低成本模型</Label>
                <Input type='text' value={economyModel} onChange={e => setEconomyModel(e.target.value)} placeholder='留空则使用高质量通道的模型' />
              </div>
            </div>

            <Separator className='my-2' />

            {/*
             * ─── Routing Mode ───
             */}
            <div className='flex flex-col gap-3'>
              <h3 className='text-sm font-semibold text-foreground'>路由模式</h3>

              <div className='flex flex-col gap-2'>
                {[
                  { value: ROUTING_MODES.BALANCED, label: '智能平衡（推荐）', desc: '高价值任务走高质量通道，高频常规任务走低成本通道。兼顾效果与成本。' },
                  { value: ROUTING_MODES.QUALITY, label: '始终高质量', desc: '所有 AI 请求都走高质量通道。适合不在意成本、追求最佳效果的场景。' },
                  { value: ROUTING_MODES.ECONOMY, label: '尽量低成本', desc: '优先使用低成本通道；未配置时回退高质量通道。适合预算有限的场景。' },
                ].map(opt => (
                  <label key={opt.value} className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${routingMode === opt.value ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'}`}>
                    <input type='radio' name='routingMode' value={opt.value} checked={routingMode === opt.value} onChange={e => setRoutingMode(e.target.value)} className='mt-0.5' />
                    <div>
                      <div className='text-sm font-medium'>{opt.label}</div>
                      <div className='text-xs text-muted-foreground mt-0.5'>{opt.desc}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <Separator className='my-2' />

            {/*
             * ─── Explanation Style ───
             */}
            <div className='flex flex-col gap-3'>
              <h3 className='text-sm font-semibold text-foreground'>讲解风格偏好</h3>
              <p className='text-xs text-muted-foreground -mt-2'>AI 生成知识点讲解时采用的语气与呈现方式，影响所有新生成的讲解内容。</p>

              <div className='flex flex-col gap-2'>
                {[
                  { value: 'colloquial', label: '口语化通俗', desc: '像老师面对面聊天，多用生活类比，遇到术语马上大白话解释。' },
                  { value: 'textbook', label: '纸质教材感', desc: '严谨、结构化、像大学讲义，层次分明、定义准确，适合打印复习。' },
                  { value: 'visual', label: '直观图解', desc: '优先用流程图、对比表、Mermaid 图表表达，文字只做必要补充。' },
                  { value: 'abstract', label: '抽象精炼', desc: '高信息密度、直击本质，省略铺垫，适合已具备基础、追求效率。' },
                ].map(opt => (
                  <label key={opt.value} className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${explainStyle === opt.value ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'}`}>
                    <input type='radio' name='explainStyle' value={opt.value} checked={explainStyle === opt.value} onChange={e => setExplainStyle(e.target.value)} className='mt-0.5' />
                    <div>
                      <div className='text-sm font-medium'>{opt.label}</div>
                      <div className='text-xs text-muted-foreground mt-0.5'>{opt.desc}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <Separator className='my-2' />

            {/*
             * ─── Image Generation ───
             */}
            <div className='flex flex-col gap-4'>
              <h3 className='text-sm font-semibold text-foreground flex items-center gap-1.5'>
                <Sparkles className='h-4 w-4' />插图生成
              </h3>

              <div className='flex flex-col gap-1.5'>
                <Label>接口地址 (Base URL)</Label>
                <Input value={imageBaseUrl} onChange={e => setImageBaseUrl(e.target.value)} placeholder='https://api.siliconflow.cn/v1' />
                <p className='text-xs text-muted-foreground mt-1'>兼容 OpenAI 图片 API 的地址，默认使用硅基流动</p>
              </div>

              <div className='flex flex-col gap-1.5'>
                <Label>API Key</Label>
                <div className='relative'>
                  <Input type={showImageKey ? 'text' : 'password'} value={imageApiKey} onChange={e => setImageApiKey(e.target.value)} placeholder='sk-...' className='pr-8' />
                  <button onClick={() => setShowImageKey(!showImageKey)} className='absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground' type='button'>
                    {showImageKey ? <EyeOff className='h-4 w-4' /> : <Eye className='h-4 w-4' />}
                  </button>
                </div>
              </div>

              <div className='flex flex-col gap-1.5'>
                <Label>生图模型</Label>
                <select value={imageModel} onChange={e => setImageModel(e.target.value)} className='flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'>
                  <option value='black-forest-labs/FLUX.1-pro'>FLUX.1-pro（最高质量，推荐）</option>
                  <option value='black-forest-labs/FLUX.1-dev'>FLUX.1-dev（高质量）</option>
                  <option value='Kwai-Kolors/Kolors'>Kolors（中等质量，速度快）</option>
                  <option value='stabilityai/stable-diffusion-3-5-large'>SD3.5 Large（高质量）</option>
                  <option value='stabilityai/stable-diffusion-xl-base-1.0'>SDXL 1.0（兼容性好）</option>
                </select>
              </div>
            </div>

          </div>

          {/*
           * ─── Test Results ───
           */}
          {testResult && (
            <div className={`flex items-center gap-2 rounded-lg border px-3.5 py-2.5 text-sm ${testResult.ok ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200' : 'border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200'}`}>
              {testResult.ok ? <CheckCircle2 className='h-4 w-4 shrink-0 text-green-600' /> : <XCircle className='h-4 w-4 shrink-0 text-red-600' />}
              {testResult.ok ? `高质量通道连接成功！模型: ${testResult.model || model}` : `高质量通道连接失败: ${testResult.error}`}
            </div>
          )}

          {economyTestResult && (
            <div className={`flex items-center gap-2 rounded-lg border px-3.5 py-2.5 text-sm ${economyTestResult.ok ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200' : 'border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200'}`}>
              {economyTestResult.ok ? <CheckCircle2 className='h-4 w-4 shrink-0 text-green-600' /> : <XCircle className='h-4 w-4 shrink-0 text-red-600' />}
              {economyTestResult.ok ? `低成本通道连接成功！模型: ${economyTestResult.model || economyModel || model}` : `低成本通道连接失败: ${economyTestResult.error}`}
            </div>
          )}

          <Separator className='mt-6' />

          {/*
           * ─── Server-side Persistence ───
           */}
          <label className='flex items-start gap-2.5 rounded-lg border border-muted p-3 cursor-pointer hover:bg-muted/30 transition-colors'>
            <input type='checkbox' checked={saveToServer} onChange={e => setSaveToServer(e.target.checked)} className='mt-0.5' />
            <div>
              <div className='text-sm font-medium'>同时保存到服务端</div>
              <div className='text-xs text-muted-foreground mt-0.5'>将 API Key 写入 <code className='bg-muted px-1 rounded'>server/.env.local</code>，重启服务端后不丢失。API Key 不会被 Git 追踪。</div>
            </div>
          </label>
          {serverSaveResult === 'ok' && (
            <div className='flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200 px-3.5 py-2.5 text-sm'>
              <CheckCircle2 className='h-4 w-4 shrink-0' />已保存到服务端
            </div>
          )}
          {serverSaveResult && serverSaveResult !== 'ok' && (
            <div className='flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200 px-3.5 py-2.5 text-sm'>
              <XCircle className='h-4 w-4 shrink-0' />保存到服务端失败：{serverSaveResult}
            </div>
          )}

          {/*
           * ─── Actions ───
           */}
          <div className='flex items-center justify-end gap-2 pt-4 border-t'>
            <Button type='button' variant='ghost' onClick={onClose}>取消</Button>
            <Button type='button' variant='outline' onClick={handleTestConnection} disabled={!apiKey || testing}>
              {testing ? <Loader2 className='h-4 w-4 mr-1 animate-spin' /> : null}
              {testing ? '测试中...' : '测试高质量通道'}
            </Button>
            <Button type='button' variant='outline' onClick={handleTestEconomyConnection} disabled={!economyApiKey || economyTesting}>
              {economyTesting ? <Loader2 className='h-4 w-4 mr-1 animate-spin' /> : null}
              {economyTesting ? '测试中...' : '测试低成本通道'}
            </Button>
            <Button type='submit' disabled={!apiKey}>保存并开始</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
