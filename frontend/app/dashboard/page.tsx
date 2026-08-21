'use client';

import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import {
  Upload,
  FileText,
  Send,
  Sparkles,
  Compass,
  Highlighter,
  BookOpen,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  ExternalLink,
  ChevronRight,
  Trash2,
  Menu
} from 'lucide-react';
import ResearchCards, { ResearchPaper } from '@/components/ResearchCards';
import ReactMarkdown from 'react-markdown';

interface DocumentMeta {
  doc_id: string;
  filename: string;
  total_pages: number;
  total_chunks: number;
}

interface Citation {
  citation_id: number;
  doc_id: string;
  filename: string;
  page: number;
  snippet: string;
  start_char: number;
  end_char: number;
}

interface Message {
  id: string;
  sender: 'user' | 'ai';
  text: string;
  citations?: Citation[];
  research_papers?: ResearchPaper[];
  research_mode?: boolean;
}

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://127.0.0.1:8000';

export default function DashboardPage() {
  const [documents, setDocuments] = useState<DocumentMeta[]>([]);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(false);
  const [uploading, setUploading] = useState<boolean>(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);

  // Chat state
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputQuery, setInputQuery] = useState<string>('');
  const [loadingAnswer, setLoadingAnswer] = useState<boolean>(false);
  const [researchMode, setResearchMode] = useState<boolean>(false);

  const chatEndRef = useRef<HTMLDivElement>(null);

  // Fetch documents on load
  useEffect(() => {
    fetchDocuments();
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loadingAnswer]);

  const fetchDocuments = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/documents`);
      if (res.ok) {
        const data = await res.json();
        setDocuments(data);
        if (data.length > 0 && !selectedDocId) {
          setSelectedDocId(data[0].doc_id);
        }
      }
    } catch (err) {
      console.error('Error fetching documents:', err);
    }
  };

  const [isDragging, setIsDragging] = useState<boolean>(false);

  const processFile = async (file: File) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setUploadStatus('Error: Please upload or drop a valid PDF document (.pdf)');
      return;
    }

    setUploading(true);
    setUploadStatus('Processing & chunking PDF document...');

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch(`${BACKEND_URL}/api/upload`, {
        method: 'POST',
        body: formData,
      });

      if (res.ok) {
        const data = await res.json();
        setUploadStatus('Document successfully indexed!');
        await fetchDocuments();
        setSelectedDocId(data.document.doc_id);
        setIsSidebarOpen(false);
      } else {
        const errData = await res.json();
        setUploadStatus(`Error: ${errData.detail || 'Failed to upload document.'}`);
      }
    } catch (err) {
      setUploadStatus('Upload failed. Please ensure FastAPI server is running on port 8000.');
    } finally {
      setUploading(false);
      setTimeout(() => setUploadStatus(null), 5000);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
  };

  const handleSendMessage = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const query = inputQuery.trim();
    if (!query || loadingAnswer) return;

    const userMsgId = Date.now().toString();
    const newMsg: Message = {
      id: userMsgId,
      sender: 'user',
      text: query,
    };

    setMessages((prev) => [...prev, newMsg]);
    setInputQuery('');
    setLoadingAnswer(true);

    try {
      const res = await fetch(`${BACKEND_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: query,
          doc_id: selectedDocId,
          research_mode: researchMode,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const aiMsg: Message = {
          id: (Date.now() + 1).toString(),
          sender: 'ai',
          text: data.answer,
          citations: data.citations || [],
          research_papers: data.research_papers || [],
          research_mode: data.research_mode,
        };
        setMessages((prev) => [...prev, aiMsg]);
      } else {
        const aiMsg: Message = {
          id: (Date.now() + 1).toString(),
          sender: 'ai',
          text: 'Sorry, an error occurred while processing your question.',
        };
        setMessages((prev) => [...prev, aiMsg]);
      }
    } catch (err) {
      const aiMsg: Message = {
        id: (Date.now() + 1).toString(),
        sender: 'ai',
        text: 'Failed to connect to backend server. Please verify FastAPI server is running at http://localhost:8000.',
      };
      setMessages((prev) => [...prev, aiMsg]);
    } finally {
      setLoadingAnswer(false);
    }
  };

  // Open PDF in a NEW TAB with target page & highlighted snippet
  const handleCitationClick = (citation: Citation) => {
    const docId = citation.doc_id || selectedDocId;
    if (!docId) return;

    const targetUrl = `/pdf-viewer?doc_id=${docId}&page=${citation.page}&snippet=${encodeURIComponent(citation.snippet)}`;
    window.open(targetUrl, '_blank');
  };

  const handleDeleteDocument = async (e: React.MouseEvent, docId: string) => {
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this research paper? This will also remove all its indexed vector chunks.')) {
      return;
    }
    
    try {
      const res = await fetch(`${BACKEND_URL}/api/documents/${docId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setDocuments((prev) => prev.filter((d) => d.doc_id !== docId));
        if (selectedDocId === docId) {
          const remaining = documents.filter((d) => d.doc_id !== docId);
          if (remaining.length > 0) {
            setSelectedDocId(remaining[0].doc_id);
          } else {
            setSelectedDocId(null);
          }
        }
        setIsSidebarOpen(false);
      } else {
        alert('Failed to delete the document.');
      }
    } catch (err) {
      console.error('Error deleting document:', err);
      alert('Error deleting document. Please check backend connection.');
    }
  };

  const selectedDoc = documents.find((d) => d.doc_id === selectedDocId);

  return (
    <div className="flex h-screen bg-[#faf9ff] saas-gradient-bg text-slate-800 selection:bg-indigo-100 selection:text-indigo-900 overflow-hidden font-sans">
      
      {/* Sidebar Mobile Backdrop */}
      <div 
        onClick={() => setIsSidebarOpen(false)}
        className={`fixed inset-0 z-30 bg-slate-900/25 backdrop-blur-sm transition-opacity duration-300 md:hidden ${
          isSidebarOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      />

      {/* Left Sidebar */}
      <aside 
        className={`fixed inset-y-0 left-0 z-40 w-72 bg-white flex flex-col justify-between border-r border-slate-200/60 transition-transform duration-300 ease-in-out md:static md:translate-x-0 md:w-80 md:bg-white/70 md:backdrop-blur-xl ${
          isSidebarOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'
        }`}
      >
        
        {/* Top Header */}
        <div className="p-4 border-b border-slate-200/50 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-1.5 text-slate-500 hover:text-indigo-600 text-xs font-semibold transition-colors">
            <ArrowLeft className="w-4 h-4" /> Back to Home
          </Link>
          <span className="bg-indigo-50 border border-indigo-100 text-indigo-700 text-[10px] font-bold px-2.5 py-0.5 rounded-full flex items-center gap-1 shadow-sm">
            <Sparkles className="w-2.5 h-2.5" /> ResearchSync
          </span>
        </div>

        {/* Drag & Drop PDF Upload Section */}
        <div className="p-4 border-b border-slate-200/50 bg-white/40">
          <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">
            Upload Research Paper (PDF)
          </h3>
          
          <label
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`flex flex-col items-center justify-center p-5 border-2 border-dashed rounded-2xl cursor-pointer transition-all text-center group ${
              isDragging
                ? 'border-indigo-600 bg-indigo-50/40 scale-[1.02]'
                : 'border-slate-200 bg-white/50 hover:bg-white hover:border-indigo-500 hover:shadow-sm'
            }`}
          >
            <Upload className={`w-6 h-6 mb-1.5 transition-colors ${isDragging ? 'text-indigo-600 animate-bounce' : 'text-slate-400 group-hover:text-indigo-600'}`} />
            <span className="text-xs font-semibold text-slate-700 group-hover:text-indigo-600">
              {isDragging ? 'Drop PDF paper here' : 'Click or drag PDF paper'}
            </span>
            <span className="text-[10px] text-slate-400 mt-1">Supports PDFs up to 50MB</span>
            <input type="file" accept=".pdf" onChange={handleFileUpload} disabled={uploading} className="hidden" />
          </label>

          {uploadStatus && (
            <div className="mt-2.5 text-xs text-slate-750 bg-white p-3 rounded-xl border border-slate-200 flex items-center gap-2 shadow-sm">
              {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-600" /> : <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />}
              <span>{uploadStatus}</span>
            </div>
          )}
        </div>

        {/* Deep Research Mode Toggle Switch */}
        <div className="p-4 border-b border-slate-200/50 bg-white/30">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center border border-indigo-100/50 shadow-sm">
                <Compass className="w-4 h-4" />
              </div>
              <div>
                <h4 className="text-xs font-bold text-slate-800">Deep Research Mode</h4>
                <p className="text-[10px] text-slate-400">Find related research papers</p>
              </div>
            </div>

            <button
              onClick={() => setResearchMode(!researchMode)}
              className={`w-11 h-6 rounded-full transition-colors relative p-0.5 ${
                researchMode ? 'bg-indigo-600' : 'bg-slate-200'
              }`}
            >
              <div
                className={`w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${
                  researchMode ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        </div>

        {/* Uploaded Documents List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">
            Uploaded Papers ({documents.length})
          </h3>

          {documents.length === 0 ? (
            <div className="text-center p-6 bg-white/40 rounded-2xl border border-slate-200/40 text-slate-400 text-xs">
              No documents uploaded yet. Upload a PDF paper above to start analyzing!
            </div>
          ) : (
            documents.map((doc) => (
              <div
                key={doc.doc_id}
                onClick={() => {
                  setSelectedDocId(doc.doc_id);
                  setIsSidebarOpen(false);
                }}
                className={`p-3.5 rounded-2xl border transition-all flex items-center justify-between cursor-pointer group ${
                  selectedDocId === doc.doc_id
                    ? 'bg-indigo-50/80 border-indigo-200 text-indigo-900 shadow-sm'
                    : 'bg-white/40 border-slate-200/50 text-slate-500 hover:border-indigo-500/50 hover:text-slate-800 hover:bg-white'
                }`}
              >
                <div className="flex items-center gap-2.5 truncate flex-1">
                  <FileText className="w-4 h-4 text-slate-400 group-hover:text-indigo-600 shrink-0" />
                  <div className="truncate">
                    <p className="text-xs font-semibold truncate text-slate-700">{doc.filename}</p>
                    <p className="text-[10px] text-slate-400">{doc.total_pages} Pages • {doc.total_chunks} Chunks</p>
                  </div>
                </div>
                
                <div className="flex items-center space-x-1 ml-2 shrink-0">
                  <button
                    onClick={(e) => handleDeleteDocument(e, doc.doc_id)}
                    className="p-1 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 md:opacity-0 group-hover:opacity-100 transition-all"
                    title="Delete paper"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                  {selectedDocId === doc.doc_id && (
                    <CheckCircle2 className="w-4 h-4 text-indigo-600" />
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-200/50 text-center text-[10px] text-slate-400">
          ResearchSync AI Engine • Powered by Gemini & Web Search Agents
        </div>
      </aside>

      {/* Main Chat Interface */}
      <main className="flex-1 flex flex-col bg-slate-50/30 overflow-hidden">
        
        {/* Top Header */}
        <header className="px-4 md:px-6 py-4 border-b border-slate-200/50 bg-white/70 backdrop-blur-md flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            {/* Mobile Sidebar Toggle */}
            <button
              onClick={() => setIsSidebarOpen(true)}
              className="p-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-500 hover:text-indigo-600 md:hidden transition-all shadow-sm shrink-0"
              title="Open papers drawer"
            >
              <Menu className="w-4 h-4" />
            </button>

            <div className="hidden xs:flex w-8 h-8 rounded-full bg-indigo-50 border border-indigo-100 text-indigo-600 items-center justify-center shadow-sm shrink-0">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-800">Research Assistant Chat</h2>
              <p className="text-xs text-slate-450 truncate max-w-sm md:max-w-md">
                {selectedDoc ? `Active Paper: ${selectedDoc.filename}` : 'No active paper selected (Global Research)'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {researchMode && (
              <span className="bg-indigo-50 text-indigo-750 border border-indigo-100/60 text-xs px-3 py-1 rounded-full font-semibold flex items-center gap-1.5 shadow-sm">
                <Compass className="w-3.5 h-3.5 text-indigo-600" /> Research Mode Active
              </span>
            )}

            {selectedDocId && (
              <button
                onClick={() => window.open(`/pdf-viewer?doc_id=${selectedDocId}`, '_blank')}
                className="px-4 py-2 rounded-full bg-white hover:bg-slate-50 text-xs font-bold text-slate-700 flex items-center gap-1.5 border border-slate-200 shadow-sm transition-all hover:scale-[1.02] hover:border-indigo-500/50 hover:text-indigo-600"
              >
                <span>View Full PDF</span>
                <ExternalLink className="w-3.5 h-3.5 text-slate-400" />
              </button>
            )}
          </div>
        </header>

        {/* Message Feed */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto my-auto space-y-4">
              <div className="w-16 h-16 rounded-3xl bg-white text-slate-800 flex items-center justify-center border border-slate-200 shadow-md">
                <BookOpen className="w-8 h-8 text-indigo-650" />
              </div>
              <h3 className="text-lg font-bold text-slate-800 tracking-tight">Ask Anything About Your Research Paper</h3>
              <p className="text-xs text-slate-500 leading-relaxed">
                Upload a research paper PDF or toggle <strong className="text-indigo-650">Deep Research Mode</strong> to analyze methodologies, conclusions, and discover related literature.
              </p>
              
              <div className="grid grid-cols-1 gap-2.5 w-full text-left pt-2">
                <button
                  onClick={() => setInputQuery("What are the key methodologies and conclusions in this paper?")}
                  className="p-3.5 rounded-2xl bg-white border border-slate-200/60 hover:border-indigo-500 hover:bg-indigo-50/10 text-xs text-slate-700 transition-all hover:scale-[1.01] hover:text-indigo-600 hover:shadow-sm"
                >
                  💡 "What are the key methodologies and conclusions in this paper?"
                </button>
                <button
                  onClick={() => setInputQuery("Find related research papers on transformer neural network attention mechanisms")}
                  className="p-3.5 rounded-2xl bg-white border border-slate-200/60 hover:border-indigo-500 hover:bg-indigo-50/10 text-xs text-slate-700 transition-all hover:scale-[1.01] hover:text-indigo-600 hover:shadow-sm"
                >
                  🔬 "Find related research papers on transformer neural network attention mechanisms"
                </button>
              </div>
            </div>
          ) : (
            messages.map((msg) => (
              <div key={msg.id} className={`flex flex-col ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}>
                <div
                  className={`max-w-3xl rounded-3xl p-5 text-sm leading-relaxed ${
                    msg.sender === 'user'
                      ? 'bg-indigo-600 text-white rounded-br-none shadow-md border border-indigo-500/20'
                      : 'bg-white border border-slate-200/60 text-slate-800 rounded-bl-none shadow-sm'
                  }`}
                >
                  <div className={`${msg.sender === 'user' ? 'text-white font-medium' : 'markdown-content'} max-w-none text-sm leading-relaxed space-y-2`}>
                    {msg.sender === 'user' ? (
                      <p>{msg.text}</p>
                    ) : (
                      <ReactMarkdown>{msg.text}</ReactMarkdown>
                    )}
                  </div>

                  {/* Citation Badges - Opens PDF in NEW TAB with Highlight */}
                  {msg.citations && msg.citations.length > 0 && (
                    <div className="mt-4 pt-3 border-t border-slate-100 space-y-2">
                      <p className="text-xs font-semibold text-slate-750 flex items-center gap-1.5">
                        <Highlighter className="w-3.5 h-3.5 text-indigo-600" /> PDF Source Citations (Click to open PDF in new tab with source highlighting):
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {msg.citations.map((c) => (
                          <button
                            key={c.citation_id}
                            onClick={() => handleCitationClick(c)}
                            className="bg-yellow-500/10 hover:bg-yellow-500/20 text-yellow-800 border border-yellow-500/20 text-xs px-3 py-1.5 rounded-full font-mono flex items-center gap-1.5 transition-all hover:scale-[1.02] shadow-sm"
                            title="Click to open PDF in new tab with source highlighted"
                          >
                            <span>[Page {c.page}]</span>
                            <span className="truncate max-w-[200px] text-[11px] opacity-80 font-sans">"{c.snippet}"</span>
                            <ExternalLink className="w-3 h-3 text-yellow-700 shrink-0" />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Research Paper Suggestions */}
                  {msg.research_papers && msg.research_papers.length > 0 && (
                    <div className="mt-4 pt-3 border-t border-slate-100">
                      <ResearchCards papers={msg.research_papers} />
                    </div>
                  )}
                </div>
              </div>
            ))
          )}

          {loadingAnswer && (
            <div className="flex items-center gap-3 text-slate-500 text-xs bg-white p-4 rounded-2xl border border-slate-200 w-fit shadow-sm">
              <Loader2 className="w-4 h-4 animate-spin text-indigo-600" />
              <span>Analyzing paper & generating answer...</span>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>

        {/* Input Bar */}
        <div className="p-4 border-t border-slate-200/50 bg-white/70 backdrop-blur-md">
          <form onSubmit={handleSendMessage} className="max-w-4xl mx-auto flex items-center gap-3">
            <div className="relative flex-1">
              <input
                type="text"
                value={inputQuery}
                onChange={(e) => setInputQuery(e.target.value)}
                placeholder={
                  researchMode
                    ? "Ask a question or enter paper topic (Research Mode Active)..."
                    : selectedDoc
                    ? `Ask about ${selectedDoc.filename}...`
                    : "Upload a PDF paper or ask any research question..."
                }
                className="w-full bg-white border border-slate-200 rounded-full px-5 py-3.5 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:shadow-sm focus:shadow-indigo-50/50 transition-all"
              />
            </div>

            <button
              type="submit"
              disabled={loadingAnswer || !inputQuery.trim()}
              className="px-6 py-3.5 rounded-full bg-slate-900 hover:bg-indigo-600 text-white font-semibold text-sm transition-all hover:scale-[1.03] active:scale-[0.97] disabled:opacity-40 disabled:hover:scale-100 flex items-center gap-2 shadow-sm"
            >
              <span>Ask</span>
              <Send className="w-4 h-4" />
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}
