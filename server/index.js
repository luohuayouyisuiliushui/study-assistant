import 'dotenv/config';
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
import learnRouter from './routes/learn.js';
import exportRouter from './routes/export.js';
import userProfileRouter from './routes/user-profile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

// Image storage directory
const IMAGES_DIR = path.join(__dirname, 'data', 'images');
fs.mkdirSync(IMAGES_DIR, { recursive: true });

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// API routes
app.use('/api/learn', exportRouter);
app.use('/api/learn', learnRouter);
app.use('/api/user-profile', userProfileRouter);

// Serve generated images
app.use('/images', express.static(IMAGES_DIR));

// Serve built React app in production
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist, { maxAge: 0, etag: false }));
app.get('/{*splat}', (req, res) => {
  // Only serve index.html for non-API routes
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(clientDist, 'index.html'));
  }
});

app.listen(PORT, (err) => {
  if (err) throw err;
  console.log(`📖 知识点学习助手已启动: http://localhost:${PORT}`);
  console.log(`   API 端点: http://localhost:${PORT}/api`);
  if (!process.env.OPENAI_API_KEY) {
    console.log('   ⚠️  未设置 OPENAI_API_KEY，请在 .env 文件或前端设置中提供 API Key');
  }
});
