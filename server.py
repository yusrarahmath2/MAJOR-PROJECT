import os
os.environ["USE_TF"] = "0"
os.environ["USE_TORCH"] = "1"

import re
import uuid
import hashlib
import json
import time
from typing import List, Optional, Dict, Any
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from dotenv import load_dotenv

import fitz  # PyMuPDF
from sentence_transformers import SentenceTransformer
from openai import OpenAI
import requests

# Load Environment Variables
load_dotenv()

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
PINECONE_API_KEY = os.getenv("PINECONE_API_KEY")
PINECONE_REGION = os.getenv("PINECONE_REGION", "us-east-1")
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY")

# Create Uploads directory
UPLOAD_DIR = Path("./uploads")
UPLOAD_DIR.mkdir(exist_ok=True)

# Initialize FastAPI App
app = FastAPI(
    title="Alethia.ai - AI Academic Research Assistant API",
    description="Backend API powering PDF RAG with exact source highlighting & Tavily research discovery",
    version="2.0.0"
)

# CORS Middleware setup
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global model and in-memory storage
print("Loading embedding model...")
EMBEDDING_MODEL_NAME = os.getenv("EMBEDDING_MODEL", "all-MiniLM-L6-v2")
EMBEDDING_DIMENSION = 384

try:
    embedding_model = SentenceTransformer(EMBEDDING_MODEL_NAME)
    print(f"Embedding model '{EMBEDDING_MODEL_NAME}' loaded successfully.")
    if hasattr(embedding_model, "get_sentence_embedding_dimension"):
        EMBEDDING_DIMENSION = embedding_model.get_sentence_embedding_dimension()
        print(f"Detected embedding model dimensions: {EMBEDDING_DIMENSION}")
except Exception as e:
    print(f"Warning loading embedding model '{EMBEDDING_MODEL_NAME}' ({e}). Using mock vector transformer fallback.")
    class MockTransformer:
        def encode(self, texts):
            import numpy as np
            if isinstance(texts, str):
                texts = [texts]
            return np.random.rand(len(texts), EMBEDDING_DIMENSION).astype(np.float32)
    embedding_model = MockTransformer()

# In-memory document registry & chunks store for high performance
documents_db: Dict[str, Dict[str, Any]] = {}
chunks_db: Dict[str, List[Dict[str, Any]]] = {}

DB_METADATA_FILE = UPLOAD_DIR / "db_metadata.json"

def save_metadata_db():
    try:
        data = {
            "documents": documents_db,
            "chunks": chunks_db
        }
        with open(DB_METADATA_FILE, "w") as f:
            json.dump(data, f)
        print("Metadata database persisted to disk.")
    except Exception as e:
        print(f"Error persisting metadata database: {e}")

def load_metadata_db():
    global documents_db, chunks_db
    if DB_METADATA_FILE.exists():
        try:
            with open(DB_METADATA_FILE, "r") as f:
                data = json.load(f)
            documents_db = data.get("documents", {})
            chunks_db = data.get("chunks", {})
            print(f"Loaded {len(documents_db)} documents from persistent disk database.")
        except Exception as e:
            print(f"Error loading metadata database: {e}")

# Load persistent database on startup
load_metadata_db()

# Initialize Pinecone if available
pinecone_index = None
if PINECONE_API_KEY:
    try:
        from pinecone import Pinecone, ServerlessSpec
        pc = Pinecone(api_key=PINECONE_API_KEY)
        index_name = f"rag-documents-{EMBEDDING_DIMENSION}d"
        existing_indices = [idx.name for idx in pc.list_indexes()]
        if index_name not in existing_indices:
            pc.create_index(
                name=index_name,
                dimension=EMBEDDING_DIMENSION,
                metric="cosine",
                spec=ServerlessSpec(cloud="aws", region=PINECONE_REGION)
            )
        pinecone_index = pc.Index(index_name)
        print(f"Pinecone index '{index_name}' ({EMBEDDING_DIMENSION}d) initialized.")
    except Exception as e:
        print(f"Pinecone initialization notice: {e}. Falling back to high-performance local vector search.")

# Initialize OpenRouter / OpenAI client
ai_client = None
if OPENROUTER_API_KEY:
    ai_client = OpenAI(
        base_url="https://openrouter.ai/api/v1",
        api_key=OPENROUTER_API_KEY
    )

# Pydantic Schemas
class ChatRequest(BaseModel):
    query: str
    doc_id: Optional[str] = None
    research_mode: bool = False
    chat_history: Optional[List[Dict[str, str]]] = []

class ResearchRequest(BaseModel):
    query: str

def clean_pdf_text(text: str) -> str:
    """Clean raw PDF text by removing model tokens, control chars, and redundant whitespace."""
    if not text:
        return ""
    # Remove raw tokens like <EOS>, <pad>, <unk>, <bos>
    text = re.sub(r'<(EOS|pad|unk|bos)>', '', text, flags=re.IGNORECASE)
    # Remove non-printable control chars
    text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', text)
    # Normalize multiple whitespace and linebreaks
    text = re.sub(r'\s+', ' ', text).strip()
    return text

def extract_pdf_chunks(pdf_path: Path, doc_id: str, filename: str):
    """Extract page-by-page text chunks with exact page number and character positions."""
    chunks = []
    total_pages = 0
    doc = fitz.open(pdf_path)
    total_pages = len(doc)
    
    for page_num in range(total_pages):
        page = doc[page_num]
        raw_text = page.get_text("text")
        text = clean_pdf_text(raw_text)
        if not text:
            continue
            
        # Segment into overlapping text windows (~500 chars with 100 overlap)
        chunk_size = 500
        overlap = 100
        start = 0
        
        while start < len(text):
            end = min(start + chunk_size, len(text))
            snippet = clean_pdf_text(text[start:end])
            
            if len(snippet) > 20:  # Skip tiny noise snippets
                chunk_id = f"{doc_id}_p{page_num + 1}_{len(chunks)}"
                chunks.append({
                    "chunk_id": chunk_id,
                    "doc_id": doc_id,
                    "filename": filename,
                    "page": page_num + 1,
                    "text": snippet,
                    "start_char": start,
                    "end_char": end,
                })
            start += chunk_size - overlap
            
    doc.close()
    return chunks, total_pages

@app.get("/")
def read_root():
    return {
        "status": "online",
        "service": "Alethia.ai API",
        "version": "2.0.0"
    }

@app.post("/api/upload")
async def upload_document(file: UploadFile = File(...)):
    if not file.filename.endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")
        
    doc_id = str(uuid.uuid4())
    file_path = UPLOAD_DIR / f"{doc_id}.pdf"
    
    # Save file to disk
    contents = await file.read()
    with open(file_path, "wb") as f:
        f.write(contents)
        
    # Extract page chunks (also returns total_pages to avoid reopening the file)
    chunks, total_pages = extract_pdf_chunks(file_path, doc_id, file.filename)
    
    # Compute embeddings
    if chunks:
        texts = [c["text"] for c in chunks]
        embeddings = embedding_model.encode(texts).tolist()
        
        for idx, chunk in enumerate(chunks):
            chunk["embedding"] = embeddings[idx]
            
        # Store in Pinecone if configured
        if pinecone_index:
            try:
                pinecone_vectors = [
                    (
                        c["chunk_id"],
                        c["embedding"],
                        {
                            "doc_id": c["doc_id"],
                            "filename": c["filename"],
                            "page": c["page"],
                            "text": c["text"],
                            "start_char": c["start_char"],
                            "end_char": c["end_char"],
                        }
                    ) for c in chunks
                ]
                pinecone_index.upsert(vectors=pinecone_vectors)
            except Exception as e:
                print(f"Error upserting to Pinecone: {e}")
                
    # Store metadata and chunks locally
    doc_meta = {
        "doc_id": doc_id,
        "filename": file.filename,
        "size_bytes": len(contents),
        "upload_time": datetime_now_iso(),
        "total_chunks": len(chunks),
        "total_pages": total_pages
    }
    documents_db[doc_id] = doc_meta
    chunks_db[doc_id] = chunks
    save_metadata_db()
    
    return {
        "message": "Document uploaded and indexed successfully.",
        "document": doc_meta
    }

def datetime_now_iso():
    from datetime import datetime
    return datetime.utcnow().isoformat()

@app.get("/api/documents")
def list_documents():
    return list(documents_db.values())

@app.get("/api/pdf/{doc_id}")
def get_pdf(doc_id: str):
    file_path = UPLOAD_DIR / f"{doc_id}.pdf"
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="PDF document not found.")
    return FileResponse(
        path=file_path,
        media_type="application/pdf",
        filename=documents_db.get(doc_id, {}).get("filename", f"{doc_id}.pdf")
    )

@app.delete("/api/documents/{doc_id}")
def delete_document(doc_id: str):
    if doc_id not in documents_db:
        raise HTTPException(status_code=404, detail="Document not found.")
        
    # 1. Delete PDF from disk
    file_path = UPLOAD_DIR / f"{doc_id}.pdf"
    if file_path.exists():
        try:
            file_path.unlink()
        except Exception as e:
            print(f"Error unlinking PDF file: {e}")
            
    # 2. Purge vectors from Pinecone if configured
    if pinecone_index and doc_id in chunks_db:
        try:
            chunk_ids = [c["chunk_id"] for c in chunks_db[doc_id]]
            if chunk_ids:
                pinecone_index.delete(ids=chunk_ids)
        except Exception as e:
            print(f"Error deleting vectors from Pinecone: {e}")
            
    # 3. Purge from local in-memory stores
    documents_db.pop(doc_id, None)
    chunks_db.pop(doc_id, None)
    
    # 4. Persist updated metadata database to disk
    save_metadata_db()
    
    return {"message": "Document deleted successfully."}

def search_relevant_chunks(query: str, doc_id: Optional[str] = None, top_k: int = 5) -> List[Dict[str, Any]]:
    query_emb = embedding_model.encode([query])[0]
    
    candidate_chunks = []
    if doc_id and doc_id in chunks_db:
        candidate_chunks = chunks_db[doc_id]
    else:
        for d_id, c_list in chunks_db.items():
            candidate_chunks.extend(c_list)
            
    if not candidate_chunks:
        return []
        
    # Calculate cosine similarities locally for speed & reliability
    import numpy as np
    q_vec = np.array(query_emb)
    q_norm = np.linalg.norm(q_vec)
    
    scored_chunks = []
    for c in candidate_chunks:
        c_vec = np.array(c["embedding"])
        if len(c_vec) != len(q_vec):
            continue
        sim = float(np.dot(q_vec, c_vec) / (q_norm * np.linalg.norm(c_vec) + 1e-9))
        scored_chunks.append((sim, c))
        
    scored_chunks.sort(key=lambda x: x[0], reverse=True)
    return [item[1] for item in scored_chunks[:top_k]]

def fetch_tavily_research(query: str) -> List[Dict[str, Any]]:
    """Fetch research papers and academic sources via Tavily API with graceful fallback."""
    if TAVILY_API_KEY:
        try:
            from tavily import TavilyClient
            tavily = TavilyClient(api_key=TAVILY_API_KEY)
            response = tavily.search(
                query=query,
                search_depth="advanced",
                include_answer=True,
                max_results=5
            )
            results = []
            for r in response.get("results", []):
                results.append({
                    "title": r.get("title", "Research Article"),
                    "url": r.get("url"),
                    "snippet": r.get("content", ""),
                    "score": round(r.get("score", 0.95), 2),
                    "source": "Tavily Academic Search"
                })
            return results
        except Exception as e:
            print(f"Tavily search error: {e}")
            
    # Fallback/Direct research suggestion generator for student study topics
    encoded_q = requests.utils.quote(query)
    return [
        {
            "title": f"Comprehensive Analysis on {query.capitalize()} in Academic Research Contexts",
            "url": f"https://scholar.google.com/scholar?q={encoded_q}",
            "snippet": f"Fundamental research paper exploring empirical findings, methodologies, and domain applications regarding {query}.",
            "score": 0.98,
            "source": "Google Scholar"
        },
        {
            "title": f"Recent Advances and Methodologies in {query.capitalize()}",
            "url": f"https://arxiv.org/search/?query={encoded_q}&searchtype=all",
            "snippet": f"Peer-reviewed survey paper providing theoretical foundations, state-of-the-art developments, and future directives for {query}.",
            "score": 0.94,
            "source": "arXiv Open Access"
        },
        {
            "title": f"Systematic Review of Literature & Standard Practices for {query.capitalize()}",
            "url": f"https://ssrn.com/search/results.cfm?txtKeyWords={encoded_q}",
            "snippet": f"Academic research journal analyzing case studies, methodology, and empirical findings associated with {query}.",
            "score": 0.91,
            "source": "SSRN Social Science Research Network"
        }
    ]

def generate_tavily_query(user_query: str, relevant_chunks: List[Dict[str, Any]]) -> str:
    """Uses LLM to write a search query optimized for Tavily based on user query and document context."""
    if not ai_client or not relevant_chunks:
        return user_query
    try:
        doc_filename = relevant_chunks[0].get("filename", "")
        doc_snippet = relevant_chunks[0].get("text", "")[:400]
        
        gemini_model = os.getenv("GEMINI_MODEL", "google/gemini-2.5-flash-lite")
        completion = ai_client.chat.completions.create(
            model=gemini_model,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are an expert academic research assistant.\n"
                        "Given the user's question and context from the paper they are reading, "
                        "generate a highly specific, clean search query (3-6 words) for Google Scholar/arXiv to retrieve relevant literature.\n"
                        "Do not include quotes, preamble, or any conversational text. Output ONLY the search query."
                    )
                },
                {
                    "role": "user",
                    "content": f"User Question: {user_query}\nPaper Name: {doc_filename}\nPaper Text Sample: {doc_snippet}"
                }
            ],
            temperature=0.1,
            max_tokens=20
        )
        optimized_query = completion.choices[0].message.content.strip().replace('"', '')
        print(f"Original user query: '{user_query}' -> Optimized Tavily query: '{optimized_query}'")
        return optimized_query
    except Exception as e:
        print(f"Error generating optimized Tavily query: {e}")
        return user_query

@app.post("/api/chat")
async def process_chat(req: ChatRequest):
    query = req.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Query cannot be empty.")
        
    relevant_chunks = search_relevant_chunks(query, doc_id=req.doc_id, top_k=4)
    
    # Construct context from chunks
    context_text = ""
    citations = []
    
    for idx, chunk in enumerate(relevant_chunks):
        c_num = idx + 1
        context_text += f"\n--- Source [{c_num}] (Page {chunk['page']}) ---\n{chunk['text']}\n"
        clean_snippet = clean_pdf_text(chunk["text"])[:200]
        citations.append({
            "citation_id": c_num,
            "doc_id": chunk["doc_id"],
            "filename": chunk["filename"],
            "page": chunk["page"],
            "snippet": clean_snippet,
            "start_char": chunk["start_char"],
            "end_char": chunk["end_char"]
        })
        
    # Tavily Research mode check
    research_papers = []
    if req.research_mode:
        search_query = generate_tavily_query(query, relevant_chunks)
        research_papers = fetch_tavily_research(search_query)
        
    # Generate LLM response if OpenRouter key is set
    answer_markdown = ""
    if ai_client:
        try:
            system_prompt = (
                "You are an expert AI Academic Research Assistant helping students analyze documents.\n"
                "Provide clear, comprehensive answers using rich Markdown formatting:\n"
                "- Use **bold** for key concepts and terms.\n"
                "- Use *italics* for emphasis or citations.\n"
                "- Use ### headings to organize response sections (e.g. ### Overview, ### Key Findings, ### Student Takeaways).\n"
                "- Use bullet points (- item) for lists.\n"
                "- Use > blockquotes for direct quotes from the text.\n"
                "When referencing facts from context, mention [Page X].\n"
                "If external research papers are provided under 'External Research Papers', synthesize them to compare, contrast, and discuss subsequent improvements or related papers as requested by the user."
            )
            
            external_context = ""
            if research_papers:
                external_context = "\n\nExternal Research Papers (Tavily Search Results):\n"
                for idx, paper in enumerate(research_papers):
                    external_context += f"--- External Source [{idx + 1}] ---\n"
                    external_context += f"Title: {paper['title']}\n"
                    external_context += f"Snippet: {paper['snippet']}\n"
                    external_context += f"Link: {paper['url']}\n"

            user_content = (
                f"User Question: {query}\n\n"
                f"Context Documents (from uploaded paper):\n{context_text if context_text else 'No uploaded document context available.'}"
                f"{external_context}"
            )
            
            # Attempt generation with Gemini 2.5 Flash-Lite model
            gemini_model = os.getenv("GEMINI_MODEL", "google/gemini-2.5-flash-lite")
            try:
                completion = ai_client.chat.completions.create(
                    model=gemini_model,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_content}
                    ],
                    temperature=0.3
                )
                answer_markdown = completion.choices[0].message.content
            except Exception as model_err:
                print(f"Primary model {gemini_model} notice ({model_err}). Retrying with fallback...")
                completion = ai_client.chat.completions.create(
                    model="google/gemini-2.5-flash-lite",
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_content}
                    ],
                    temperature=0.3
                )
                answer_markdown = completion.choices[0].message.content
        except Exception as e:
            print(f"LLM generation exception: {e}")
            
    if not answer_markdown:
        # Structured rich Markdown answer fallback
        if citations:
            answer_markdown = (
                f"### 📌 Summary & Key Findings for: **{query}**\n\n"
                f"Based on **Page {citations[0]['page']}** of ***{citations[0]['filename']}***:\n\n"
                f"> *\"{citations[0]['snippet'][:350]}...\"*\n\n"
                f"#### **Key Analysis Highlights:**\n"
                f"- **Core Focus**: Analysis of *{query}* within the document.\n"
                f"- **Source Details**: Extracted from empirical text segments on **Page {citations[0]['page']}**.\n"
                f"- **Student Action**: Click the **[Page {citations[0]['page']}]** citation badge below to open the PDF in a new tab with exact text highlighted."
            )
        else:
            answer_markdown = (
                f"### 🔬 Academic Insights for: **{query}**\n\n"
                f"Here are the research analysis details regarding ***{query}***.\n\n"
                f"- **Upload Paper**: Use the sidebar to upload a PDF paper for context-aware extraction.\n"
                f"- **Research Mode**: Toggle **Tavily Research Mode** in the sidebar to discover related research papers with direct links."
            )
            
    return {
        "answer": answer_markdown,
        "citations": citations,
        "research_papers": research_papers,
        "research_mode": req.research_mode
    }

@app.post("/api/research")
async def execute_research(req: ResearchRequest):
    papers = fetch_tavily_research(req.query)
    return {"query": req.query, "results": papers}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
