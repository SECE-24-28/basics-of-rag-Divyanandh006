import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import authRouter from './routes/auth.js';
import chatsRouter from './routes/chats.js';
import messagesRouter from './routes/messages.js';
import filesRouter from './routes/files.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRouter);
app.use('/api/chats', chatsRouter);
app.use('/api/chats/:chatId/files', filesRouter);
app.use('/api/messages', messagesRouter);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Start Express Server
const server = app.listen(PORT, () => {
  console.log(`✅ Backend running at http://localhost:${PORT}`);
});

// --- Python RAG Server Automatic Management ---
let pythonProcess = null;

async function isPythonServerRunning() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1000);
    const res = await fetch('http://127.0.0.1:5001/health', { signal: controller.signal });
    clearTimeout(timeoutId);
    return res.ok;
  } catch (err) {
    return false;
  }
}

async function startPythonRAGServer() {
  const isRunning = await isPythonServerRunning();
  if (isRunning) {
    console.log('ℹ️ Python RAG server is already running on port 5001.');
    return;
  }

  // Path to python executable in virtual environment
  const venvPython = process.platform === 'win32'
    ? path.resolve(__dirname, '..', '..', '.venv', 'Scripts', 'python.exe')
    : path.resolve(__dirname, '..', '..', '.venv', 'bin', 'python');

  const scriptPath = path.resolve(__dirname, 'rag_server.py');

  console.log(`🚀 Starting Python RAG server: "${venvPython}" "${scriptPath}"`);

  // Spawn Python service
  pythonProcess = spawn(venvPython, [scriptPath], {
    env: { ...process.env },
    stdio: 'inherit',
    shell: false
  });

  pythonProcess.on('error', (err) => {
    console.error('❌ Failed to start Python RAG server:', err);
  });

  pythonProcess.on('close', (code) => {
    if (code !== 0 && code !== null) {
      console.warn(`⚠️ Python RAG server stopped with exit code: ${code}`);
    } else {
      console.log('ℹ️ Python RAG server process closed.');
    }
  });
}

// Boot Python RAG service
startPythonRAGServer();

// Graceful cleanup of Python subprocess on Node termination
const cleanup = () => {
  if (pythonProcess) {
    console.log('🧹 Shutting down Python RAG server...');
    pythonProcess.kill('SIGTERM');
    pythonProcess = null;
  }
};

process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  cleanup();
  process.exit(1);
});

