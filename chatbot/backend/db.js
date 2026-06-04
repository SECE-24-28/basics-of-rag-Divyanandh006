import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, 'chatbot.db'));

db.pragma('journal_mode = DELETE');

// Initialize database schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    is_verified INTEGER DEFAULT 0,
    verification_code TEXT,
    verification_expires DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'New Chat',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'model')),
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS chat_files (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
  );
`);

// Run migration for chats table to add user_id if it doesn't exist
const tableInfo = db.prepare("PRAGMA table_info(chats)").all();
const hasUserId = tableInfo.some(column => column.name === 'user_id');
if (!hasUserId) {
  try {
    db.exec(`
      ALTER TABLE chats ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
    `);
    console.log("Migration successful: added user_id to chats table.");
  } catch (err) {
    console.error("Error during migration of chats table:", err);
  }
}

const hasSystemInstruction = tableInfo.some(column => column.name === 'system_instruction');
if (!hasSystemInstruction) {
  try {
    db.exec(`ALTER TABLE chats ADD COLUMN system_instruction TEXT DEFAULT '';`);
    console.log("Migration successful: added system_instruction to chats table.");
  } catch (err) {
    console.error("Error during migration (system_instruction):", err);
  }
}

const hasTemperature = tableInfo.some(column => column.name === 'temperature');
if (!hasTemperature) {
  try {
    db.exec(`ALTER TABLE chats ADD COLUMN temperature REAL DEFAULT 0.7;`);
    console.log("Migration successful: added temperature to chats table.");
  } catch (err) {
    console.error("Error during migration (temperature):", err);
  }
}

export default db;
