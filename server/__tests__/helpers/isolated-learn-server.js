import express from 'express';
import http from 'node:http';
import learnRouter from '../../routes/learn.js';
import assessmentRouter from '../../routes/assessment.js';
import contentRouter from '../../routes/content.js';
import exportRouter from '../../routes/export.js';
import studyTraceRouter from '../../routes/study-trace.js';
import masteryRouter from '../../routes/mastery.js';

const app = express();
app.use(express.json());
app.use('/api/learn', exportRouter);
app.use('/api/learn', assessmentRouter);
app.use('/api/learn', contentRouter);
app.use('/api/learn', masteryRouter);
app.use('/api/learn', learnRouter);
app.use('/api/study-trace', studyTraceRouter);
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

const server = http.createServer(app);

server.once('error', error => {
  process.send?.({ error: error.message });
  process.exitCode = 1;
});

server.listen(0, '127.0.0.1', () => {
  process.send?.({ port: server.address().port });
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
process.once('disconnect', shutdown);
