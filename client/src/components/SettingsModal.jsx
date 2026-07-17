import { useState } from 'react';
import api from '../api';
import { Button } from '#/components/ui/button';
import { Input } from '#/components/ui/input';
import { Label } from '#/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from '#/components/ui/dialog';
import { Settings, Eye, EyeOff, Loader2, CheckCircle2, XCircle, AlertCircle, Sparkles } from 'lucide-react';
import { Separator } from '#/components/ui/separator';
import { loadSettings, saveSettings } from '#/lib/settings-storage';

export default function SettingsModal({ isOpen, onClose, onSave }) {
  const saved = loadSettings();
  const [apiKey, setApiKey] = useState(saved.apiKey || '');
  const [baseURL, setBaseURL] = useState(saved.baseURL || 'https://api.openai.com/v1');
  const [model, setModel] = useState(saved.model || 'gpt-4o-mini');
  const [showKey, setShowKey] = useState(false);
  const [imageApiKey, setImageApiKey] = useState(saved.imageApiKey || '');
  const [imageModel, setImageModel] = useState(saved.imageModel || 'black-forest-labs/FLUX.1-dev');
  const [showImageKey, setShowImageKey] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);

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

  const handleSave = () => {
    const settings = { apiKey, baseURL, model, imageApiKey, imageModel };
    saveSettings(settings);
    onSave(settings);
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className='max-w-lg'>
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

            <div className='flex flex-col gap-4'>
              <h3 className='text-sm font-semibold text-foreground'>AI 设置</h3>

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
                <p className='text-xs text-muted-foreground mt-1'>支持 OpenAI、DeepSeek、SiliconFlow 等兼容 API</p>
              </div>

              <div className='flex flex-col gap-1.5'>
                <Label>模型</Label>
                <Input type='text' value={model} onChange={e => setModel(e.target.value)} placeholder='gpt-4o-mini' />
              </div>
            </div>

            <Separator className='my-2' />

            <div className='flex flex-col gap-4 mt-6 pt-2 border-t'>
              <h3 className='text-sm font-semibold text-foreground flex items-center gap-1.5'>
                <Sparkles className='h-4 w-4' />插图生成（硅基流动）
              </h3>

              <div className='flex flex-col gap-1.5'>
                <Label>生图 API Key</Label>
                <div className='relative'>
                  <Input type={showImageKey ? 'text' : 'password'} value={imageApiKey} onChange={e => setImageApiKey(e.target.value)} placeholder='sk-...' className='pr-8' />
                  <button onClick={() => setShowImageKey(!showImageKey)} className='absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground' type='button'>
                    {showImageKey ? <EyeOff className='h-4 w-4' /> : <Eye className='h-4 w-4' />}
                  </button>
                </div>
                <p className='text-xs text-muted-foreground mt-1'>使用硅基流动（SiliconFlow）API Key，用于为知识点生成配图</p>
              </div>

              <div className='flex flex-col gap-1.5'>
                <Label>生图模型</Label>
                <select value={imageModel} onChange={e => setImageModel(e.target.value)} className='flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'>
                  <option value='black-forest-labs/FLUX.1-dev'>FLUX.1-dev（高质量，推荐）</option>
                  <option value='Kwai-Kolors/Kolors'>Kolors（中等质量，速度快）</option>
                  <option value='stabilityai/stable-diffusion-3-5-large'>SD3.5 Large（高质量）</option>
                  <option value='stabilityai/stable-diffusion-xl-base-1.0'>SDXL 1.0（兼容性好）</option>
                </select>
              </div>
            </div>

          </div>

          {testResult && (
            <div className={`flex items-center gap-2 rounded-lg border px-3.5 py-2.5 text-sm mt-6 ${testResult.ok ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200' : 'border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200'}`}>
              {testResult.ok ? <CheckCircle2 className='h-4 w-4 shrink-0 text-green-600' /> : <XCircle className='h-4 w-4 shrink-0 text-red-600' />}
              {testResult.ok ? `连接成功！模型: ${testResult.model || model}` : `连接失败: ${testResult.error}`}
            </div>
          )}

          <Separator className='mt-6' />

          <div className='flex items-center justify-end gap-2 pt-4 border-t'>
            <Button type='button' variant='ghost' onClick={onClose}>取消</Button>
            <Button type='button' variant='outline' onClick={handleTestConnection} disabled={!apiKey || testing}>
              {testing ? <Loader2 className='h-4 w-4 mr-1 animate-spin' /> : null}
              {testing ? '测试中...' : '测试连接'}
            </Button>
            <Button type='submit' disabled={!apiKey}>保存并开始</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
