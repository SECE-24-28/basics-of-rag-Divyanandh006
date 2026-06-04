# 🧠 Full-Stack AI Chatbot with RAG (React + Express + Python + Gemini)

A premium, glassmorphic AI Chatbot platform built with a **React (Vite) frontend**, a **Node/Express + SQLite backend**, and a **Python Flask RAG (Retrieval-Augmented Generation) service** powered by **ChromaDB** and the **Google Gemini API**.

---

## 🌟 Features

* **Secure Authentication:** Register, login, and verify email via a 6-digit OTP (Developer fallback outputs OTP to console logs; SMTP supported for production).
* **Semantic Document RAG:** Upload PDFs, Word documents (`.docx`), text files (`.txt`, `.md`) to index and search their contents semantically.
* **Multimodal Image Support:** Upload images (`.png`, `.jpg`, `.jpeg`, `.webp`). The RAG server uses Gemini vision models to describe or transcribe their contents and make them searchable.
* **Word-Safe Paragraph Chunking:** Text is processed and chunked using a sentence/paragraph-aware chunking function (800-character limits, 150-character semantic overlaps) to ensure no words or sentences are cut in half.
* **Local Embedding Generation:** Generates embeddings locally on your CPU using Hugging Face's lightweight `all-MiniLM-L6-v2` SentenceTransformer model (saving cloud cost and ensuring zero-latency vector generation).
* **Multi-Chat Session Management:** Create, switch between, rename, and delete chat rooms. Custom databases clean up physical files and embeddings automatically upon chat deletion.
* **Professional Typography & Custom Markdown:** Chat displays support code blocks with copy-to-clipboard buttons, nested bullet lists (automatic indentation and custom shapes), blockquotes, headers, and formatted links.
* **Automated Service Management:** The Node backend automatically manages the lifecycle of the Python RAG service, booting it up in the background from your virtual environment when you run the project.

---

## 🛠️ Tech Stack

* **Frontend:** React, Vite, Vanilla CSS (Glassmorphism dark theme, custom responsive grid, CSS transitions/animations).
* **Express Backend:** Node.js, Express, `better-sqlite3` (relational database for users, chat sessions, messages, and file metadata), JWT tokens for authentication.
* **Python RAG Server:** Python 3, Flask, ChromaDB (vector database), SentenceTransformers (Hugging Face embeddings), pdfplumber (PDF extraction), docx (Word extraction).

---

## 🚀 Quick Start & Installation

### Prerequisite
Make sure you have Node.js (v18+) and Python 3.10+ installed on your system.

### 1. Configure the Python Virtual Environment
Run the following from the project root to install the RAG dependencies inside the virtual environment:
```bash
# Install python requirements in the local venv
.venv\Scripts\pip install -r requirements.txt
```

### 2. Set Up the Express Backend
1. Navigate to the backend directory:
   ```bash
   cd chatbot/backend
   ```
2. Install Node dependencies:
   ```bash
   npm install
   ```
3. Configure the environment variables by creating a `.env` file in `chatbot/backend/`:
   ```env
   GEMINI_API_KEY=your_google_gemini_api_key_here
   PORT=3002
   
   # Optional: Configure SMTP for real email OTP deliveries
   # SMTP_HOST=smtp.gmail.com
   # SMTP_PORT=587
   # SMTP_SECURE=false
   # SMTP_USER=your_email@gmail.com
   # SMTP_PASS=your_app_password
   ```
   *(Note: If SMTP parameters are left blank, verification OTPs will print directly to the backend node terminal console).*
4. Launch the backend:
   ```bash
   npm run dev
   ```
   *This starts the Node server on **http://localhost:3002** and automatically launches the Python RAG service on **http://127.0.0.1:5001**.*

### 3. Set Up the React Frontend
1. Open a new terminal and navigate to the frontend directory:
   ```bash
   cd chatbot/frontend
   ```
2. Install Node dependencies:
   ```bash
   npm install
   ```
3. Launch the Vite dev server:
   ```bash
   npm run dev
   ```
4. Open the displayed address (usually **http://localhost:5173**) in your browser.

---

## ⚠️ Quota & Rate Limit Reminders (Google Gemini API)

If you are using the **Google Gemini API Free Tier**:
* The API enforces a limit of **15 Requests Per Minute (RPM)** and **1,500 Requests Per Day (RPD)**.
* Doing rapid image uploads or sending multiple prompts in a short period might trigger a `429 Too Many Requests` error. If this happens, simply wait 30 seconds for the quota block to clear and resume.
* When restarting the backend server, wait **5-10 seconds** before uploading files to allow the Python RAG service to fully load PyTorch and the SentenceTransformer model into RAM.
