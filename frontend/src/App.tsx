import { useState, useRef, useEffect } from 'react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import type { User } from 'firebase/auth';
import { auth } from './firebaseConfig';
import { Login } from './Login';

interface Source {
  title: string;
  uri: string;
  language?: string;
  documentType?: string;
}

const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  betriebsanleitung: 'Betriebsanleitungen',
  broschuere: 'Broschüren',
  datenblatt: 'Datenblätter',
  montageanleitung: 'Montageanleitungen',
  zertifikat: 'Zertifikate',
  zeichnung: 'Zeichnungen',
  sonstiges: 'Weitere Dokumente'
};

interface Message {
  id: string;
  role: 'user' | 'agent';
  text: string;
  timestamp: string;
  sources?: Source[];
  citations?: any[];
  references?: any[];
}

const BACKEND_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:8080/api/chat'
  : 'https://klaro-backend-161764644775.europe-west3.run.app/api/chat';

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      role: 'agent',
      text: 'Hallo! Ich bin dein **KLARO KI-Assistent**. Wie kann ich dir heute bei Fragen rund um Kleinkläranlagen, Wartung oder klares Wasser helfen?',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    },
  ]);
  const [input, setInput] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Auth-Status-Beobachter
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setIsAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Auto-scroll to bottom whenever messages list or loading state changes
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isLoading]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userText = input;
    setInput('');
    setIsLoading(true);

    const userMessage: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      text: userText,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMessage]);

    try {
      // Firebase ID-Token für sichere Authentifizierung holen
      const token = await auth.currentUser?.getIdToken();

      const response = await fetch(BACKEND_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        },
        body: JSON.stringify({
          message: userText,
          sessionId: sessionId,
        }),
      });

      if (!response.ok) {
        throw new Error('Netzwerk-Antwort war nicht ok.');
      }

      const data = await response.json();

      const agentMessage: Message = {
        id: `agent-${Date.now()}`,
        role: 'agent',
        text: data.reply || 'Keine Antwort erhalten.',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        sources: data.sources || [],
        citations: data.citations || [],
        references: data.references || [],
      };

      if (data.session) {
        setSessionId(data.session);
      }

      setMessages((prev) => [...prev, agentMessage]);
    } catch (error) {
      console.error('Fehler bei der API-Abfrage:', error);
      
      const errorMessage: Message = {
        id: `error-${Date.now()}`,
        role: 'agent',
        text: 'Entschuldigung, es gab ein Problem bei der Verbindung mit dem KLARO Server. Bitte versuche es gleich noch einmal.',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };

      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleReset = () => {
    setMessages([
      {
        id: 'welcome',
        role: 'agent',
        text: 'Chat zurückgesetzt. Hallo! Ich bin dein **KLARO KI-Assistent**. Wie kann ich dir heute helfen?',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
    ]);
    setSessionId(null);
    setInput('');
  };

  // Hilfsfunktion zum Rendern von strukturiertem Text (Fettgedrucktes, Listen, Absätze)
  // und Gruppieren der PDF-Quellennachweise (Citations) am Ende jedes Absatzes (de-dupliziert)
  const renderMessageText = (text: string, citations?: any[], references?: any[]) => {
    // Zeilenbasiertes Splitting zuerst, um perfekte Absatz-Strukturen zu garantieren
    const lines = text.split('\n');
    let absoluteOffset = 0;

    return lines.map((line, lineIdx) => {
      const lineLength = line.length;
      const lineStart = absoluteOffset;
      const lineEnd = absoluteOffset + lineLength;

      // Absoluter Offset für die nächste Zeile aktualisieren (inklusive des '\n'-Zeichens)
      absoluteOffset += lineLength + 1;

      // Filter alle Zitate, die in dieser Zeile/Absatz vorkommen (auch bei leichten Grenz-Abweichungen)
      const lineCitations = (citations || [])
        .map(c => ({
          startIndex: parseInt(c.startIndex, 10),
          endIndex: parseInt(c.endIndex, 10),
          refId: parseInt(c.sources?.[0]?.referenceId, 10)
        }))
        .filter(c => !isNaN(c.startIndex) && !isNaN(c.endIndex) && !isNaN(c.refId))
        .filter(c => c.endIndex >= lineStart && c.startIndex <= lineEnd);

      // Eindeutige Referenz-IDs für diesen Absatz ermitteln und sortieren
      const uniqueRefIds = Array.from(new Set(lineCitations.map(c => c.refId))).sort((a, b) => a - b);

      // Zustandssteuerung für Fettgedrucktes
      let isBoldActive = false;

      const formatBold = (str: string) => {
        const boldParts = str.split(/(\*\*)/g);
        return boldParts.map((bPart, bIdx) => {
          if (bPart === '**') {
            isBoldActive = !isBoldActive;
            return null; // Die Asteriske selbst nicht rendern
          }
          if (isBoldActive) {
            return <strong key={bIdx} style={{ fontWeight: '700', color: '#1a365d' }}>{bPart}</strong>;
          }
          return bPart;
        });
      };

      // Render die Zitate für diesen Absatz
      const citationElements = uniqueRefIds.map((refId) => {
        const ref = references?.[refId];
        if (!ref) return null;

        const metadata = ref.chunkInfo?.documentMetadata;
        const uri = metadata?.uri || metadata?.structData?.fields?.public_url?.stringValue || metadata?.structData?.fields?.url?.stringValue;
        let title = metadata?.structData?.fields?.document_title?.stringValue || metadata?.title;
        if (!title || title === 'Untitled' || title === 'untitled') {
          title = uri ? uri.split('/').pop().replace(/_/g, ' ').replace('.pdf', '') : 'Dokument';
        }

        return (
          <a
            key={`inline-cit-${lineIdx}-${refId}`}
            href={uri}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-citation-badge"
            title={title}
          >
            <svg viewBox="0 0 24 24" className="inline-pdf-icon">
              <path d="M19,3H5C3.89,3 3,3.89 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5C21,3.89 20.1,3 19,3M19,19H5V5H19V19M10,10.5H14V11.5H11.5V12.5H13.5V13.5H11.5V15H10V10.5M14.5,10.5H17.5A1.5,1.5 0 0,1 19,12V13.5A1.5,1.5 0 0,1 17.5,15H14.5V10.5M16,12V13.5H17.5V12H16M5.5,10.5H8.5V11.5H5.5V12.5H8V13.5H5.5V15H4V10.5H5.5" />
            </svg>
            {refId + 1}
          </a>
        );
      });

      // Zeile auf Liste prüfen
      const isBullet = line.trim().startsWith('* ') || line.trim().startsWith('- ') || line.trim().startsWith('• ');

      if (isBullet) {
        const cleanedFirstSeg = line.replace(/^\s*[\*\-•]\s*/, '');
        const renderedFirstSeg = formatBold(cleanedFirstSeg);
        return (
          <span key={lineIdx} className="chat-bullet-item" style={{ display: 'flex', gap: '8px', margin: '6px 0 6px 12px', paddingLeft: '8px' }}>
            <span style={{ color: 'var(--klaro-blue)', fontWeight: 'bold' }}>•</span>
            <span style={{ lineHeight: '1.6' }}>
              {renderedFirstSeg}
              {citationElements}
            </span>
          </span>
        );
      }

      // Leere Zeile = Absatz-Abstand
      if (line.trim() === '') {
        return <span key={lineIdx} style={{ display: 'block', height: '12px' }} />;
      }

      // Normaler Textblock mit angehängten Zitaten am Ende
      return (
        <span key={lineIdx} style={{ display: 'block', margin: '4px 0', lineHeight: '1.6' }}>
          {formatBold(line)}
          {citationElements}
        </span>
      );
    });
  };

  if (isAuthLoading) {
    return (
      <div className="login-container">
        <div className="typing-indicator" style={{ display: 'flex', gap: '8px' }}>
          <span className="typing-dot"></span>
          <span className="typing-dot"></span>
          <span className="typing-dot"></span>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Login onLoginSuccess={() => {}} />;
  }

  return (
    <div className="chat-app-container">
      {/* Header */}
      <header className="chat-header">
        <div className="chat-header-brand">
          <div className="chat-logo-container">
            {/* Wassertropfen-Icon SVG */}
            <svg viewBox="0 0 24 24">
              <path d="M12,2.69C12,2.69 19,10.15 19,14A7,7 0 0,1 12,21A7,7 0 0,1 5,14C5,10.15 12,2.69 12,2.69M12,19.5A5.5,5.5 0 0,0 17.5,14C17.5,11.57 12.87,7.27 12,6.43C11.13,7.27 6.5,11.57 6.5,14A5.5,5.5 0 0,0 12,19.5Z" />
            </svg>
          </div>
          <div className="chat-header-info">
            <h1>KLARO KI-Assistent</h1>
            <p>
              <span className="chat-status-dot"></span>
              Klärt deine Fragen
            </p>
          </div>
        </div>
        <div className="chat-header-actions">
          <button className="chat-reset-btn" onClick={handleReset} title="Chat-Verlauf löschen">
            {/* Reset Icon */}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
            Neu starten
          </button>
          <button className="chat-reset-btn" onClick={() => signOut(auth)} title="Abmelden" style={{ borderColor: 'rgba(217, 56, 58, 0.2)', color: '#d9383a' }}>
            {/* Sign Out Icon */}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Abmelden
          </button>
        </div>
      </header>

      {/* Messages Scroll Area */}
      <main className="chat-messages-scrollarea">
        {messages.map((msg) => (
          <div key={msg.id} className={`message-row ${msg.role === 'user' ? 'user-msg' : 'agent-msg'}`}>
            <div className="message-avatar">
              {msg.role === 'user' ? 'U' : 'K'}
            </div>
            <div className="message-bubble-wrapper">
              <div className="message-bubble">
                {renderMessageText(msg.text, msg.citations, msg.references)}
              </div>

              {/* Gefundene Dokumente / PDF-Quellen rendering */}
              {msg.role === 'agent' && msg.sources && msg.sources.length > 0 && (
                <div className="message-sources-container">
                  <span className="sources-title">Gefundene Dokumente:</span>
                  {Object.entries(
                    msg.sources.reduce((groups, src) => {
                      const type = src.documentType || 'sonstiges';
                      if (!groups[type]) groups[type] = [];
                      groups[type].push(src);
                      return groups;
                    }, {} as Record<string, Source[]>)
                  ).map(([type, items]) => (
                    <div key={type} className="sources-group">
                      <span className="sources-group-title">
                        {DOCUMENT_TYPE_LABELS[type] || DOCUMENT_TYPE_LABELS.sonstiges}
                      </span>
                      <div className="sources-list">
                        {items.map((src, idx) => (
                          <a 
                            key={idx} 
                            href={src.uri} 
                            target="_blank" 
                            rel="noopener noreferrer" 
                            className="source-link-badge"
                            title={src.title}
                          >
                            <svg viewBox="0 0 24 24" className="source-pdf-icon">
                              <path d="M19,3H5C3.89,3 3,3.89 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5C21,3.89 20.1,3 19,3M19,19H5V5H19V19M10,10.5H14V11.5H11.5V12.5H13.5V13.5H11.5V15H10V10.5M14.5,10.5H17.5A1.5,1.5 0 0,1 19,12V13.5A1.5,1.5 0 0,1 17.5,15H14.5V10.5M16,12V13.5H17.5V12H16M5.5,10.5H8.5V11.5H5.5V12.5H8V13.5H5.5V15H4V10.5H5.5" />
                            </svg>
                            {src.title}
                          </a>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <span className="message-meta">{msg.timestamp}</span>
            </div>
          </div>
        ))}

        {/* Loading Indicator */}
        {isLoading && (
          <div className="message-row agent-msg">
            <div className="message-avatar">K</div>
            <div className="message-bubble-wrapper">
              <div className="message-bubble">
                <div className="typing-indicator">
                  <span className="typing-dot"></span>
                  <span className="typing-dot"></span>
                  <span className="typing-dot"></span>
                </div>
              </div>
            </div>
          </div>
        )}
        <div ref={scrollRef} />
      </main>

      {/* Input Form */}
      <footer className="chat-input-container">
        <form onSubmit={handleSend} className="chat-input-form">
          <input
            type="text"
            className="chat-text-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Stelle eine Frage zu KLARO Kleinkläranlagen..."
            disabled={isLoading}
            autoFocus
          />
          <button type="submit" className="chat-send-button" disabled={isLoading || !input.trim()}>
            Senden
          </button>
        </form>
        <p className="chat-footer-note">
          KLARO KI-Assistent • Klares Wasser. Gesunde Zukunft.
        </p>
      </footer>
    </div>
  );
}

export default App;
