# =====================================================
# RAG SERVICE FOR CHATBOT (GPU SAFE)
# =====================================================

import os
# ----------- FORCE CPU ------------
os.environ["CUDA_VISIBLE_DEVICES"] = ""

import sys
import uuid
import logging
from flask import Flask, request, jsonify
from flask_cors import CORS

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("rag_service")

# Check imports delay load
try:
    import torch
    torch.cuda.is_available = lambda: False
    from sentence_transformers import SentenceTransformer
    import chromadb
    import pdfplumber
    import docx
    import google.generativeai as genai
except ImportError as e:
    logger.error(f"Required libraries missing: {e}")
    sys.exit(1)

# =====================================================
# INITIALIZE MODELS AND CHROMADB
# =====================================================

logger.info("🧠 Loading Embedding Model (all-MiniLM-L6-v2) on CPU...")
embedding_model = SentenceTransformer("all-MiniLM-L6-v2", device="cpu")
logger.info("✅ Embedding Model Loaded.")

logger.info("📁 Initializing Persistent ChromaDB Client...")
# Initialize ChromaDB persistent storage inside backend folder
db_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "chroma_db")
chroma_client = chromadb.PersistentClient(path=db_path)
collection = chroma_client.get_or_create_collection(name="chatbot_rag_collection")
logger.info(f"✅ ChromaDB client initialized. Path: {db_path}")

app = Flask(__name__)
CORS(app)

# =====================================================
# CORE FUNCTIONS
# =====================================================

def clean_text(text):
    """Cleans up formatting noise from raw text."""
    import re
    if not text:
        return ""
    # Replace multiple newlines with double newlines
    text = re.sub(r'\n{3,}', '\n\n', text)
    # Replace multiple spaces/tabs with a single space
    text = re.sub(r'[ \t]+', ' ', text)
    return text.strip()


def chunk_text(text, chunk_size=800, overlap=150):
    """Chunks text cleanly without splitting words or sentences in half."""
    import re
    if not text:
        return []
    
    text = clean_text(text)
    paragraphs = text.split('\n\n')
    chunks = []
    
    current_chunk = []
    current_length = 0
    
    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
            
        # If the paragraph is too large on its own, split it into sentences
        if len(para) > chunk_size:
            # First, flush whatever is in current_chunk
            if current_chunk:
                chunks.append("\n\n".join(current_chunk))
                current_chunk = []
                current_length = 0
                
            # Split paragraph into sentences
            # Regex splits on sentence endings followed by space
            sentences = re.split(r'(?<=[.!?])\s+', para)
            
            for sentence in sentences:
                sentence = sentence.strip()
                if not sentence:
                    continue
                
                # If a single sentence is abnormally large, split it by words
                if len(sentence) > chunk_size:
                    words = sentence.split(' ')
                    temp_chunk = []
                    temp_len = 0
                    for word in words:
                        if temp_len + len(word) + 1 > chunk_size:
                            chunks.append(" ".join(temp_chunk))
                            # overlap: carry over last 20% of words
                            overlap_count = max(1, len(temp_chunk) // 5)
                            temp_chunk = temp_chunk[-overlap_count:] + [word]
                            temp_len = sum(len(w) for w in temp_chunk) + len(temp_chunk) - 1
                        else:
                            temp_chunk.append(word)
                            temp_len += len(word) + 1
                    if temp_chunk:
                        chunks.append(" ".join(temp_chunk))
                else:
                    if current_length + len(sentence) + 2 > chunk_size:
                        chunks.append(" ".join(current_chunk))
                        # overlap: carry over last sentence if possible
                        if current_chunk:
                            current_chunk = [current_chunk[-1], sentence]
                            current_length = len(current_chunk[0]) + len(sentence) + 1
                        else:
                            current_chunk = [sentence]
                            current_length = len(sentence)
                    else:
                        current_chunk.append(sentence)
                        current_length += len(sentence) + (1 if current_length > 0 else 0)
        else:
            if current_length + len(para) + 2 > chunk_size:
                chunks.append("\n\n".join(current_chunk))
                # overlap: carry over last paragraph
                if current_chunk:
                    current_chunk = [current_chunk[-1], para]
                    current_length = len(current_chunk[0]) + len(para) + 2
                else:
                    current_chunk = [para]
                    current_length = len(para)
            else:
                current_chunk.append(para)
                current_length += len(para) + (2 if current_length > 0 else 0)
                
    if current_chunk:
        chunks.append("\n\n".join(current_chunk))
        
    return [c.strip() for c in chunks if c.strip()]


def extract_pdf_text(file_path):
    """Extracts text page by page from a PDF."""
    full_text = ""
    with pdfplumber.open(file_path) as pdf:
        for page in pdf.pages:
            text = page.extract_text()
            if text:
                full_text += text + "\n"
    return full_text


def extract_docx_text(file_path):
    """Extracts text from paragraphs in a DOCX file."""
    doc = docx.Document(file_path)
    full_text = []
    for para in doc.paragraphs:
        if para.text.strip():
            full_text.append(para.text)
    return "\n".join(full_text)


def extract_image_text_via_gemini(file_path, file_type, api_key):
    """Uses Gemini vision multimodal capability to transcribe/describe images."""
    if not api_key:
        logger.error("Gemini API key is required to process images.")
        return "[Error: Gemini API key is missing for processing images]"

    models_to_try = []
    env_model = os.environ.get("GEMINI_MODEL")
    if env_model:
        models_to_try.append(env_model)
    for m in ["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash", "gemini-flash-latest"]:
        if m not in models_to_try:
            models_to_try.append(m)

    last_error = None
    for model_name in models_to_try:
        try:
            genai.configure(api_key=api_key)
            model = genai.GenerativeModel(model_name)
            
            with open(file_path, "rb") as f:
                image_bytes = f.read()

            logger.info(f"🔮 Sending image to Gemini ({model_name}) for text extraction/description...")
            prompt = (
                "Extract all text from this image as verbatim as possible. "
                "If there is no text in the image, describe the contents of the image in detail, "
                "listing all key objects, diagrams, charts, and details so that it can be searched later via a RAG system."
            )
            response = model.generate_content([
                prompt,
                {"mime_type": file_type, "data": image_bytes}
            ])
            logger.info(f"✅ Success with Gemini model: {model_name}")
            return response.text
        except Exception as e:
            logger.warning(f"⚠️ Failed with Gemini model {model_name}: {e}")
            last_error = e

    logger.error(f"❌ Failed to process image via any Gemini model. Last error: {last_error}")
    return f"[Error processing image: {str(last_error)}]"


def extract_pdf_text_via_gemini(file_path, api_key):
    """Uses Gemini to extract/transcribe text from a PDF file."""
    if not api_key:
        raise ValueError("Gemini API key is required.")

    models_to_try = []
    env_model = os.environ.get("GEMINI_MODEL")
    if env_model:
        models_to_try.append(env_model)
    for m in ["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash", "gemini-flash-latest"]:
        if m not in models_to_try:
            models_to_try.append(m)

    last_error = None
    for model_name in models_to_try:
        try:
            genai.configure(api_key=api_key)
            model = genai.GenerativeModel(model_name)
            
            with open(file_path, "rb") as f:
                pdf_bytes = f.read()

            logger.info(f"🔮 Sending PDF to Gemini ({model_name}) for text extraction...")
            prompt = (
                "Extract all text from this document as verbatim as possible. "
                "Maintain structure, headings, and lists where possible. "
                "Do not summarize or explain; only return the extracted text content of the document."
            )
            response = model.generate_content([
                prompt,
                {"mime_type": "application/pdf", "data": pdf_bytes}
            ])
            logger.info(f"✅ Success extracting PDF text with Gemini model: {model_name}")
            return response.text
        except Exception as e:
            logger.warning(f"⚠️ Failed PDF extraction with model {model_name}: {e}")
            last_error = e

    raise last_error or RuntimeError("Failed to extract PDF text via any Gemini model.")


# =====================================================
# API ENDPOINTS
# =====================================================

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "service": "rag_server"}), 200


@app.route("/index", methods=["POST"])
def index_document():
    """Extracts, chunks, embeds, and stores a document in ChromaDB."""
    data = request.json or {}
    file_path = data.get("file_path")
    chat_id = data.get("chat_id")
    file_id = data.get("file_id")
    file_type = data.get("file_type", "")
    filename = data.get("filename", "")

    if not file_path or not chat_id or not file_id:
        return jsonify({"error": "Missing required fields: file_path, chat_id, file_id"}), 400

    if not os.path.exists(file_path):
        return jsonify({"error": f"File path does not exist: {file_path}"}), 404

    try:
        logger.info(f"📄 Processing indexing request for file: {filename} (Type: {file_type}) in Chat: {chat_id}")
        
        # 1. Text Extraction based on file type
        text = ""
        file_ext = os.path.splitext(file_path)[1].lower()

        if file_ext == ".pdf" or "pdf" in file_type:
            try:
                text = extract_pdf_text(file_path)
            except Exception as e:
                logger.warning(f"⚠️ pdfplumber failed to extract text from PDF: {e}")
                text = ""
            
            if not text or not text.strip():
                logger.info("🔮 PDF text is empty or failed to extract locally. Attempting to extract text via Gemini...")
                api_key = os.environ.get("GEMINI_API_KEY")
                if api_key:
                    try:
                        text = extract_pdf_text_via_gemini(file_path, api_key)
                    except Exception as gemini_err:
                        logger.error(f"❌ Gemini PDF extraction failed: {gemini_err}")
                else:
                    logger.warning("⚠️ No Gemini API key available for PDF extraction fallback.")
        elif file_ext in [".docx", ".doc"] or "officedocument.wordprocessingml" in file_type:
            text = extract_docx_text(file_path)
        elif file_ext in [".txt", ".md"] or "text/" in file_type:
            with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                text = f.read()
        elif file_ext in [".png", ".jpg", ".jpeg", ".webp"] or "image/" in file_type:
            api_key = os.environ.get("GEMINI_API_KEY")
            text = extract_image_text_via_gemini(file_path, file_type, api_key)
        else:
            # Fallback: try reading as text
            try:
                with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                    text = f.read()
            except Exception:
                return jsonify({"error": f"Unsupported file type: {file_type} / {file_ext}"}), 400

        if not text or not text.strip():
            logger.warning(f"⚠️ No text could be extracted from {filename}")
            return jsonify({"status": "warning", "message": "No text extracted", "chunks_indexed": 0}), 200

        # 2. Chunking
        chunks = chunk_text(text)
        logger.info(f"✂️ Split {filename} into {len(chunks)} chunks.")

        if not chunks:
            return jsonify({"status": "success", "message": "Document empty, no chunks indexed", "chunks_indexed": 0}), 200

        # 3. Embedding Generation & Storing
        for i, chunk in enumerate(chunks):
            embedding = embedding_model.encode(chunk, convert_to_numpy=True).tolist()
            chunk_id = f"{file_id}_chunk_{i}"
            
            collection.add(
                documents=[chunk],
                embeddings=[embedding],
                metadatas=[{
                    "chat_id": chat_id,
                    "file_id": file_id,
                    "filename": filename,
                    "chunk_index": i
                }],
                ids=[chunk_id]
            )

        logger.info(f"✅ Indexed {len(chunks)} chunks from {filename} successfully.")
        return jsonify({
            "status": "success",
            "message": f"Successfully indexed {filename}",
            "chunks_indexed": len(chunks)
        }), 200

    except Exception as e:
        logger.error(f"❌ Error indexing document: {e}", exc_info=True)
        return jsonify({"error": "Failed to index document", "details": str(e)}), 500


@app.route("/query", methods=["POST"])
def query_context():
    """Queries ChromaDB for context matches related to a chat session."""
    data = request.json or {}
    query = data.get("query")
    chat_id = data.get("chat_id")
    top_k = int(data.get("top_k", 5))

    if not query or not chat_id:
        return jsonify({"error": "Missing required fields: query, chat_id"}), 400

    try:
        # Generate query embedding
        query_embedding = embedding_model.encode(query, convert_to_numpy=True).tolist()

        # ── FIX: count how many chunks actually exist for this chat ────────────
        # ChromaDB raises an error if n_results > number of matching documents.
        # This happens whenever a small PDF (few pages) is uploaded, or after an
        # image is deleted and a new PDF is uploaded to the same chat.
        existing = collection.get(where={"chat_id": chat_id})
        available = len(existing.get("ids", []))
        logger.info(f"📊 Available chunks for Chat {chat_id}: {available}")

        if available == 0:
            logger.info(f"ℹ️ No indexed chunks found for Chat {chat_id}. Returning empty context.")
            return jsonify({"chunks": []}), 200

        safe_k = min(top_k, available)
        # ──────────────────────────────────────────────────────────────────────

        # Query collection with chat metadata filter to maintain separation
        results = collection.query(
            query_embeddings=[query_embedding],
            n_results=safe_k,
            where={"chat_id": chat_id}
        )

        documents = results.get("documents", [[]])[0]
        logger.info(f"🔍 Query for Chat {chat_id} retrieved {len(documents)} context chunks.")

        return jsonify({"chunks": documents}), 200
    except Exception as e:
        logger.error(f"❌ Error querying vector database: {e}", exc_info=True)
        return jsonify({"error": "Failed to query context", "details": str(e)}), 500


@app.route("/delete", methods=["POST"])
def delete_embeddings():
    """Deletes chunks from the collection by file_id or chat_id."""
    data = request.json or {}
    file_id = data.get("file_id")
    chat_id = data.get("chat_id")

    if not file_id and not chat_id:
        return jsonify({"error": "Missing filter field: file_id or chat_id"}), 400

    try:
        if file_id:
            logger.info(f"🗑️ Deleting all chunks for File: {file_id}")
            collection.delete(where={"file_id": file_id})
        elif chat_id:
            logger.info(f"🗑️ Deleting all chunks for Chat: {chat_id}")
            collection.delete(where={"chat_id": chat_id})

        return jsonify({"status": "success", "message": "Embeddings deleted"}), 200
    except Exception as e:
        logger.error(f"❌ Error deleting embeddings: {e}", exc_info=True)
        return jsonify({"error": "Failed to delete embeddings", "details": str(e)}), 500


# =====================================================
# RUN APPLICATION
# =====================================================

if __name__ == "__main__":
    port = int(os.environ.get("RAG_PORT", 5001))
    logger.info(f"🚀 Starting RAG Server on port {port}...")
    app.run(host="0.0.0.0", port=port, debug=False)
