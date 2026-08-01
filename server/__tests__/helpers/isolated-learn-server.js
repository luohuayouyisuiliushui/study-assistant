import express from 'express';
import http from 'node:http';
import learnRouter from '../../routes/learn.js';
import masteryRouter from '../../routes/mastery.js';

const app = express();
app.use(express.json());
app.use('/api/learn', masteryRouter);
app.use('/api/learn', learnRouter);

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
