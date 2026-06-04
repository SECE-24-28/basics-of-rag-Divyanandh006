import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import db from '../db.js';
import auth from '../middleware/auth.js';

const router = express.Router();

// Apply authentication middleware to all chat routes
router.use(auth);

router.get('/', (req, res) => {
  const chats = db.prepare(`
    SELECT * FROM chats WHERE user_id = ? ORDER BY updated_at DESC
  `).all(req.user.id);
  res.json(chats);
});

router.post('/', (req, res) => {
  const id = uuidv4();
  const { title = 'New Chat' } = req.body;
  
  db.prepare(`INSERT INTO chats (id, title, user_id) VALUES (?, ?, ?)`).run(id, title, req.user.id);
  const chat = db.prepare(`SELECT * FROM chats WHERE id = ?`).get(id);
  res.status(201).json(chat);
});

router.patch('/:id', (req, res) => {
  const { title } = req.body;
  const chatId = req.params.id;

  // Check ownership
  const chat = db.prepare(`SELECT * FROM chats WHERE id = ? AND user_id = ?`).get(chatId, req.user.id);
  if (!chat) {
    return res.status(404).json({ error: 'Chat not found or access denied' });
  }

  db.prepare(`UPDATE chats SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(title, chatId);
  res.json({ success: true });
});

router.delete('/:id', async (req, res) => {
  const chatId = req.params.id;

  // Check ownership
  const chat = db.prepare(`SELECT * FROM chats WHERE id = ? AND user_id = ?`).get(chatId, req.user.id);
  if (!chat) {
    return res.status(404).json({ error: 'Chat not found or access denied' });
  }

  try {
    // 1. Get all uploaded files for this chat
    const chatFiles = db.prepare('SELECT file_path FROM chat_files WHERE chat_id = ?').all(chatId);

    // 2. Request Python RAG service to delete vector embeddings for this chat
    console.log(`📡 Requesting deletion of vector embeddings for Chat: ${chatId}`);
    const delResponse = await fetch('http://127.0.0.1:5001/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId })
    }).catch(err => {
      console.warn('⚠️ Python RAG delete request failed:', err.message);
      return { ok: false };
    });

    // 3. Delete physical files from disk
    for (const file of chatFiles) {
      if (fs.existsSync(file.file_path)) {
        try {
          fs.unlinkSync(file.file_path);
          console.log(`✅ Cleaned up file from disk: ${file.file_path}`);
        } catch (unlinkErr) {
          console.error(`Failed to delete physical file ${file.file_path}:`, unlinkErr);
        }
      }
    }

    // 4. Delete the chat (cascading automatically deletes DB file entries and messages)
    db.prepare(`DELETE FROM chats WHERE id = ?`).run(chatId);
    
    res.json({ success: true, message: 'Chat and all associated files deleted successfully' });
  } catch (err) {
    console.error('❌ Failed during chat deletion cleanup:', err);
    res.status(500).json({ error: 'Failed to delete chat', details: err.message });
  }
});

export default router;
