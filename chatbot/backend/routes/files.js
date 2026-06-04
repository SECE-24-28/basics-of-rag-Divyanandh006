import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import auth from '../middleware/auth.js';

// Setup file router with chat path parameters merged
const router = express.Router({ mergeParams: true });

// Protect all files endpoints
router.use(auth);

// Configure multer storage inside a local 'uploads' directory
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(process.cwd(), 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = `${uuidv4()}${ext}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 } // 15MB limit
});

// GET /api/messages/:chatId/files - List files for a chat
// Note: We use mergeParams so req.params.chatId is accessible
router.get('/', (req, res) => {
  const { chatId } = req.params;
  
  // Verify chat ownership
  const chat = db.prepare('SELECT * FROM chats WHERE id = ? AND user_id = ?').get(chatId, req.user.id);
  if (!chat) {
    return res.status(404).json({ error: 'Chat not found or access denied' });
  }

  try {
    const files = db.prepare(`
      SELECT id, filename, original_name, file_type, file_size, created_at 
      FROM chat_files 
      WHERE chat_id = ? 
      ORDER BY created_at DESC
    `).all(chatId);
    
    res.json(files);
  } catch (error) {
    console.error('Failed to get files:', error);
    res.status(500).json({ error: 'Failed to retrieve files list' });
  }
});

// POST /api/messages/:chatId/files - Upload and index file
router.post('/', upload.single('file'), async (req, res) => {
  const { chatId } = req.params;
  
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const tempFilePath = req.file.path;

  try {
    // Verify chat ownership
    const chat = db.prepare('SELECT * FROM chats WHERE id = ? AND user_id = ?').get(chatId, req.user.id);
    if (!chat) {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      return res.status(404).json({ error: 'Chat not found or access denied' });
    }

    const fileId = uuidv4();
    const fileRecord = {
      id: fileId,
      chat_id: chatId,
      filename: req.file.filename,
      original_name: req.file.originalname,
      file_path: req.file.path,
      file_type: req.file.mimetype,
      file_size: req.file.size
    };

    // Insert file metadata into SQLite
    db.prepare(`
      INSERT INTO chat_files (id, chat_id, filename, original_name, file_path, file_type, file_size)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      fileRecord.id,
      fileRecord.chat_id,
      fileRecord.filename,
      fileRecord.original_name,
      fileRecord.file_path,
      fileRecord.file_type,
      fileRecord.file_size
    );

    // Call Python RAG Server for text parsing & embeddings generation
    console.log(`📡 Sending file to Python RAG service: ${fileRecord.original_name} (${fileId})`);
    
    const indexResponse = await fetch('http://127.0.0.1:5001/index', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        file_path: fileRecord.file_path,
        chat_id: fileRecord.chat_id,
        file_id: fileRecord.id,
        file_type: fileRecord.file_type,
        filename: fileRecord.original_name
      })
    });

    if (!indexResponse.ok) {
      const errData = await indexResponse.json().catch(() => ({}));
      throw new Error(errData.error || `RAG service returned status ${indexResponse.status}`);
    }

    const indexResult = await indexResponse.json();
    console.log(`✅ File indexed: ${fileRecord.original_name}. Chunks: ${indexResult.chunks_indexed}`);

    res.status(201).json({
      id: fileId,
      filename: fileRecord.filename,
      original_name: fileRecord.original_name,
      file_type: fileRecord.file_type,
      file_size: fileRecord.file_size,
      chunks_indexed: indexResult.chunks_indexed
    });

  } catch (error) {
    console.error('❌ File processing failed:', error);
    // Cleanup physical file
    if (fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (delErr) {
        console.error('Failed to delete temp file:', delErr);
      }
    }
    // Cleanup DB entry if created
    try {
      db.prepare('DELETE FROM chat_files WHERE file_path = ?').run(tempFilePath);
    } catch (dbErr) {
      console.error('Failed to cleanup DB row:', dbErr);
    }

    res.status(500).json({ error: 'Failed to process and index file', details: error.message });
  }
});

// DELETE /api/messages/:chatId/files/:fileId - Delete file and its embeddings
router.delete('/:fileId', async (req, res) => {
  const { chatId, fileId } = req.params;

  // Verify chat ownership
  const chat = db.prepare('SELECT * FROM chats WHERE id = ? AND user_id = ?').get(chatId, req.user.id);
  if (!chat) {
    return res.status(404).json({ error: 'Chat not found or access denied' });
  }

  const fileRecord = db.prepare('SELECT * FROM chat_files WHERE id = ? AND chat_id = ?').get(fileId, chatId);
  if (!fileRecord) {
    return res.status(404).json({ error: 'File not found' });
  }

  try {
    // 1. Tell Python RAG service to delete vector embeddings
    console.log(`📡 Deleting file chunks from ChromaDB: ${fileRecord.original_name} (${fileId})`);
    
    const delResponse = await fetch('http://127.0.0.1:5001/delete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        file_id: fileId
      })
    });

    if (!delResponse.ok) {
      console.warn(`⚠️ Python service failed to delete chunks for ${fileId}, continuing with local cleanup.`);
    }

    // 2. Delete database entry
    db.prepare('DELETE FROM chat_files WHERE id = ?').run(fileId);

    // 3. Delete file from local filesystem
    if (fs.existsSync(fileRecord.file_path)) {
      fs.unlinkSync(fileRecord.file_path);
      console.log(`✅ File deleted from filesystem: ${fileRecord.file_path}`);
    }

    res.json({ success: true, message: 'File and embeddings deleted successfully' });

  } catch (error) {
    console.error('❌ Failed to delete file:', error);
    res.status(500).json({ error: 'Failed to delete file', details: error.message });
  }
});

export default router;
