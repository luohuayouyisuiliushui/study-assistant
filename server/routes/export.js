import { Router } from 'express';
import * as store from '../engine/learn-store.js';
import { generateAnkiCSV, generateOPML, generateNotionCSV, generateTopicJSON, generateStudyNotes, exportPlanBundle } from '../engine/export-engine.js';

const router = Router();

router.get('/plans/:planId/export/anki/:topicId', (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  const topic = plan.topics.find(t => t.id === req.params.topicId);
  if (!topic) return res.status(404).json({ error: '知识点不存在' });
  if (!topic.detail) return res.status(400).json({ error: '该知识点还没有讲解内容，无法导出' });

  const csv = generateAnkiCSV(plan, req.params.topicId);
  if (!csv) return res.status(500).json({ error: '生成 Anki CSV 失败' });

  const filename = `${topic.title.replace(/[/\\?%*:|"<>]/g, '_')}.anki.csv`;
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.send(csv);
});

router.get('/plans/:planId/export/opml/:topicId', (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  const opml = generateOPML(plan, req.params.topicId);
  if (!opml) return res.status(400).json({ error: '无法生成 OPML 大纲' });

  const topic = plan.topics.find(t => t.id === req.params.topicId);
  const filename = `${(topic?.title || 'outline').replace(/[/\\?%*:|"<>]/g, '_')}.opml`;
  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.send(opml);
});

router.get('/plans/:planId/export/notion', (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  const csv = generateNotionCSV(plan);
  const filename = `${plan.name.replace(/[/\\?%*:|"<>]/g, '_')}.notion.csv`;
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.send(csv);
});

router.get('/plans/:planId/export/json/:topicId', (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  const data = generateTopicJSON(plan, req.params.topicId);
  if (!data) return res.status(404).json({ error: '知识点不存在' });

  res.json(data);
});

router.get('/plans/:planId/export/notes/:topicId', (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  const notes = generateStudyNotes(plan, req.params.topicId);
  if (!notes) return res.status(400).json({ error: '无法生成学习笔记' });

  const topic = plan.topics.find(t => t.id === req.params.topicId);
  const filename = `${(topic?.title || 'notes').replace(/[/\\?%*:|"<>]/g, '_')}.md`;
  res.set('Content-Type', 'text/markdown; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.send(notes);
});

router.get('/plans/:planId/export/bundle', (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  const bundle = exportPlanBundle(plan);
  res.json(bundle);
});

export default router;
