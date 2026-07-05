import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import learnRouter from './routes/learn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// API routes
app.use('/api/learn', learnRouter);

// Serve built React app in production
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res) => {
  // Only serve index.html for non-API routes
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(clientDist, 'index.html'));
  }
});

app.listen(PORT, () => {
  console.log(`📖 知识点学习助手已启动: http://localhost:${PORT}`);
  console.log(`   API 端点: http://localhost:${PORT}/api`);
  if (!process.env.OPENAI_API_KEY) {
    console.log('   ⚠️  未设置 OPENAI_API_KEY，请在 .env 文件或前端设置中提供 API Key');
  }
});
