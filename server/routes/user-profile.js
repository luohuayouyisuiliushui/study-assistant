/**
 * User Profile API routes.
 * Provides endpoints for cross-plan user profile analysis.
 */
import { Router } from 'express';
import {
  aggregateAllPlans,
  generateUserProfile,
  getUserProfileForDisplay,
  getProfileSummary,
} from '../engine/user-profile.js';
import { getAIInvocation } from './middleware.js';

const router = Router();

// ─── Routes ───

/**
 * GET /api/user-profile
 * Get current user profile (if already generated).
 */
router.get('/', (req, res) => {
  const profile = getUserProfileForDisplay();
  if (!profile) {
    return res.status(404).json({ error: '画像尚未生成，请先调用分析接口' });
  }
  res.json({ profile });
});

/**
 * POST /api/user-profile/analyze
 * Trigger AI-powered cross-plan profile generation.
 * Requires API key (via header, body, or env).
 */
router.post('/analyze', async (req, res) => {
  try {
    const aggregated = aggregateAllPlans();
    if (!aggregated) {
      return res.status(400).json({ error: '没有学习计划数据，无法生成画像' });
    }
    if (!process.env.OPENAI_API_KEY && !req.headers['x-api-key'] && !req.body?.apiKey) {
      return res.status(400).json({ error: '请提供 API Key' });
    }
    const { provider, model } = getAIInvocation(req);
    const profile = await generateUserProfile(provider, model);
    res.json({ profile });
  } catch (err) {
    console.error('[user-profile] 生成画像失败:', err.message);
    res.status(500).json({ error: '生成画像失败: ' + err.message });
  }
});

/**
 * GET /api/user-profile/summary
 * Lightweight cross-plan statistics without AI.
 */
router.get('/summary', (req, res) => {
  const summary = getProfileSummary();
  res.json({ summary });
});

export default router;
