// Force stdout/stderr to be unbuffered on Windows (real-time log visibility)
if (process.stdout._handle && typeof process.stdout._handle.setBlocking === 'function') {
  process.stdout._handle.setBlocking(true);
}
if (process.stderr._handle && typeof process.stderr._handle.setBlocking === 'function') {
  process.stderr._handle.setBlocking(true);
}
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import learnRouter from './routes/learn.js';
import exportRouter from './routes/export.js';
import assessmentRouter from './routes/assessment.js';
import contentRouter from './routes/content.js';
import userProfileRouter from './routes/user-profile.js';
import settingsRouter from './routes/settings.js';
import studyTraceRouter from './routes/study-trace.js';
import masteryRouter from './routes/mastery.js';
import { createApiAuthorization, getListenHost, isAllowedBrowserOrigin } from './security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env.local') });
dotenv.config({ path: path.join(__dirname, '.env') });
const app = express();
const PORT = process.env.PORT || 3001;
const HOST = getListenHost();

// Image storage directory
const IMAGES_DIR = path.join(__dirname, 'data', 'images');
fs.mkdirSync(IMAGES_DIR, { recursive: true });

// Middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api')) {
      console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
    }
  });
  next();
});
app.use(cors({
  origin(origin, callback) {
    callback(isAllowedBrowserOrigin(origin) ? null : new Error('CORS origin denied'), true);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
}));
app.use(express.json({ limit: '10mb' }));
app.use('/api', createApiAuthorization());

// API routes
app.use('/api/learn', exportRouter);
app.use('/api/learn', assessmentRouter);
app.use('/api/learn', contentRouter);
app.use('/api/learn', masteryRouter);
app.use('/api/learn', learnRouter);
app.use('/api/user-profile', userProfileRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/study-trace', studyTraceRouter);

// Serve generated images
app.use('/images', express.static(IMAGES_DIR));

// Serve built React app in production
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist, { maxAge: 0, etag: false }));
app.get('/{*splat}', (req, res) => {
  // Only serve index.html for non-API routes
  if (!req.path.startsWith('/api')) {
    res.sendFile('index.html', { root: clientDist });
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error(`[unhandled] ${req.method} ${req.path}:`, err.stack || err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

app.listen(PORT, HOST, (err) => {
  if (err) throw err;
  console.log(`📖 知识点学习助手已启动: http://${HOST}:${PORT}`);
  console.log(`   API 端点: http://${HOST}:${PORT}/api`);
  if (!process.env.OPENAI_API_KEY) {
    console.log('   ⚠️  未设置 OPENAI_API_KEY，请在 .env 文件或前端设置中提供 API Key');
  }
});
