import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import db from '../db.js';
import auth from '../middleware/auth.js';
import 'dotenv/config';

const router = express.Router();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Protect all message routes
router.use(auth);

router.get('/:chatId', (req, res) => {
  const { chatId } = req.params;

  // Check chat ownership
  const chat = db.prepare('SELECT * FROM chats WHERE id = ? AND user_id = ?').get(chatId, req.user.id);
  if (!chat) {
    return res.status(404).json({ error: 'Chat not found or access denied' });
  }

  const messages = db.prepare(`
    SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC
  `).all(chatId);
  res.json(messages);
});

router.post('/:chatId', async (req, res) => {
  const { chatId } = req.params;
  const { content } = req.body;

  if (!content?.trim()) return res.status(400).json({ error: 'Message content required' });

  // Check chat ownership
  const chat = db.prepare('SELECT * FROM chats WHERE id = ? AND user_id = ?').get(chatId, req.user.id);
  if (!chat) {
    return res.status(404).json({ error: 'Chat not found or access denied' });
  }

  const userMsgId = uuidv4();
  db.prepare(`INSERT INTO messages (id, chat_id, role, content) VALUES (?, ?, 'user', ?)`)
    .run(userMsgId, chatId, content);

  if (chat.title === 'New Chat') {
    const shortTitle = content.slice(0, 50);
    db.prepare(`UPDATE chats SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(shortTitle, chatId);
  } else {
    db.prepare(`UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(chatId);
  }

  const history = db.prepare(`
    SELECT role, content FROM messages WHERE chat_id = ? ORDER BY created_at ASC
  `).all(chatId);

  // Convert role 'model' from db to 'model' for Gemini (user stays user)
  const geminiHistory = history.slice(0, -1).map(msg => ({
    role: msg.role === 'model' ? 'model' : 'user',
    parts: [{ text: msg.content }]
  }));

  // Check if any files are uploaded for this chat
  const filesCount = db.prepare('SELECT COUNT(*) as count FROM chat_files WHERE chat_id = ?').get(chatId).count;
  let ragContext = '';

  if (filesCount > 0) {
    try {
      console.log(`📡 Fetching RAG context for chat ${chatId}: "${content}"`);
      const ragResponse = await fetch('http://127.0.0.1:5001/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: content, chat_id: chatId, top_k: 6 })
      });

      if (ragResponse.ok) {
        const ragData = await ragResponse.json();
        const chunks = ragData.chunks || [];
        if (chunks.length > 0) {
          ragContext = chunks.join('\n\n');
          console.log(`✅ Retrieved ${chunks.length} context chunks from Python RAG server.`);
        } else {
          console.log('ℹ️ No matching context chunks found in ChromaDB.');
        }
      } else {
        console.warn(`⚠️ Python RAG server query failed with status: ${ragResponse.status}`);
      }
    } catch (err) {
      console.error('❌ Error querying Python RAG server:', err.message);
    }
  }

  let promptToSend = content;
  if (ragContext) {
    promptToSend = `You are an AI assistant. You have been provided with documents as context to answer the user's question.

Retrieved Context:
${ragContext}

User Question:
${content}

Instructions:
1. If the user's question is a general greeting (e.g. "hi", "hello"), pleasantry (e.g. "thanks", "thank you"), or a general request unrelated to the document contents, respond naturally and politely.
2. If the user's question is asking for information, facts, or details, answer it clearly and professionally formatted using the provided Retrieved Context.
3. Summarize or synthesize facts from multiple parts of the context if needed to provide a complete, well-structured, and comprehensive answer.
4. If the answer cannot be found or reasonably inferred from the provided Retrieved Context, reply politely stating that the information is not mentioned in the uploaded documents, and briefly summarize what general topics are covered in the context instead.`;
  }

  try {
    const modelsToTry = [];
    if (process.env.GEMINI_MODEL) {
      modelsToTry.push(process.env.GEMINI_MODEL);
    }
    const defaultModels = ['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-flash-latest'];
    for (const m of defaultModels) {
      if (!modelsToTry.includes(m)) {
        modelsToTry.push(m);
      }
    }

    let result = null;
    let lastError = null;

    for (const modelName of modelsToTry) {
      try {
        console.log(`📡 Attempting to use Gemini model: ${modelName}`);
        const model = genAI.getGenerativeModel({ 
          model: modelName,
          safetySettings: [
            {
              category: HarmCategory.HARM_CATEGORY_HARASSMENT,
              threshold: HarmBlockThreshold.BLOCK_NONE,
            },
            {
              category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
              threshold: HarmBlockThreshold.BLOCK_NONE,
            },
            {
              category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
              threshold: HarmBlockThreshold.BLOCK_NONE,
            },
            {
              category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
              threshold: HarmBlockThreshold.BLOCK_NONE,
            },
          ]
        });
        const chat_session = model.startChat({
          history: geminiHistory,
          generationConfig: { maxOutputTokens: 8192 }
        });

        result = await chat_session.sendMessage(promptToSend);
        console.log(`✅ Success with Gemini model: ${modelName}`);
        break;
      } catch (err) {
        console.warn(`⚠️ Failed with Gemini model ${modelName}:`, err.message || err);
        lastError = err;
      }
    }

    if (!result) {
      throw lastError || new Error('Failed to get response from any Gemini model');
    }

    const aiResponse = result.response.text();

    const aiMsgId = uuidv4();
    db.prepare(`INSERT INTO messages (id, chat_id, role, content) VALUES (?, ?, 'model', ?)`)
      .run(aiMsgId, chatId, aiResponse);

    res.json({
      userMessage: { id: userMsgId, chat_id: chatId, role: 'user', content },
      aiMessage: { id: aiMsgId, chat_id: chatId, role: 'model', content: aiResponse }
    });
  } catch (error) {
    console.error('Gemini error:', error);
    res.status(500).json({ error: 'Failed to get AI response', details: error.message });
  }
});

export default router;
