import db from './db.js';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runTest() {
  const sourcePdf = 'C:\\Users\\divya\\Downloads\\GATE_cs_Portion.pdf';
  const uploadDir = path.join(__dirname, 'uploads');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const tempFilename = `${uuidv4()}.pdf`;
  const destPdf = path.join(uploadDir, tempFilename);

  console.log(`Copying ${sourcePdf} to ${destPdf}...`);
  fs.copyFileSync(sourcePdf, destPdf);

  const fileId = uuidv4();
  const chatId = 'd9a5bb4e-a8bc-462c-b5ae-862e182f3c7e'; // valid chat ID from DB

  const fileRecord = {
    id: fileId,
    chat_id: chatId,
    filename: tempFilename,
    original_name: 'GATE_cs_Portion.pdf',
    file_path: destPdf,
    file_type: 'application/pdf',
    file_size: fs.statSync(destPdf).size
  };

  try {
    console.log('Inserting mock file record to DB...');
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

    console.log('Calling Python RAG server at http://127.0.0.1:5001/index...');
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

    console.log('Response status:', indexResponse.status);
    const resData = await indexResponse.json().catch(() => ({}));
    console.log('Response body:', resData);

  } catch (err) {
    console.error('Test failed with error:', err);
  } finally {
    // clean up from DB
    db.prepare('DELETE FROM chat_files WHERE id = ?').run(fileId);
    if (fs.existsSync(destPdf)) {
      fs.unlinkSync(destPdf);
    }
  }
}

runTest();
