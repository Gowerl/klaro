# KLARO KI-Assistent — Projekt-Dokumentation (GEMINI.md)

Diese Dokumentation dient als zentrales, langlebiges Gedächtnis des Repositories. Sie beschreibt die Architektur, Sicherheitsmechanismen, Features und Codestandards des KLARO Vertex AI Agenten.

---

## 🏗️ 1. Architektur-Übersicht

Das Projekt ist als moderne Web-Applikation konzipiert, die für eine hochgradig skalierbare, serverlose Bereitstellung (z. B. auf **Google Cloud Run**) optimiert ist.

*   **Backend (`server.js`):** Node.js Express Server, der statische Frontend-Dateien ausliefert und als sichere Schnittstelle (API Proxy) zu den Google Cloud APIs fungiert.
*   **Frontend (`frontend/`):** Eine Single-Page-Applikation (SPA) auf Basis von **React + TypeScript + Vite**. Sie wird im produktiven Build komplett vorkompiliert und durch das Backend ausgeliefert.
*   **Wissensdatenbank (Vertex AI / Google Discovery Engine):**
    *   **PDF-Dokumente:** GCS-Datenspeicher `klaro_rag_metadaten_pdfs`
    *   **Website-Inhalte:** Webdaten-Speicher `klaro-webpage`
    *   Schnittstelle über den `ConversationalSearchServiceClient` (Beta-API).

---

## 🔒 2. Zugriffskontrolle (Security & Auth)

Um unberechtigte API-Abfragen und unkontrollierte Vertex AI Kosten zu verhindern, ist die Chat-Route abgesichert:

### Firebase Authentication (JWT-basiert)
*   Das Frontend authentifiziert Benutzer über Firebase Auth.
*   Bei jeder API-Anfrage an `/api/chat` holt das Frontend ein kurzlebiges, kryptografisch signiertes **Firebase ID-Token (JWT)** und überträgt es im Header: `Authorization: Bearer <ID_TOKEN>`.
*   Das Backend nutzt eine Middleware (`verifyToken`), die mithilfe des **Firebase Admin SDK** die Gültigkeit des Tokens und dessen Signatur dezentral verifiziert (`getAuth().verifyIdToken(idToken)`).
*   **Vorteil:** Das System ist komplett **zustandslos (stateless)**, wodurch der Server auf Cloud Run blitzschnell skalieren kann, ohne aktive Benutzersitzungen zu verlieren.

---

## 🌐 3. Multilinguale Sprachfilterung (Language Isolation)

Da manche Dokumente im Vertex-Datenspeicher fehlerhafte Metadaten aufweisen (z. B. spanische oder italienische PDFs, die fälschlicherweise als `"language": "de"` markiert wurden), verwendet das Backend ein **hochgradig robustes, mehrstufiges Filterverfahren (`extractLanguage`)**:

1.  **URI-Sprachcodes (Höchste Priorität):** Prüft den Pfad und Dateinamen auf exakte, isolierte Länder-Tags wie `-de-`, `-en-`, `-fr-`, `-es-`, `-it-`, `/de/`, `/en/` etc.
2.  **Multilinguale Signalwörter:** Sucht nach typischen nationalen Schlüsselwörtern im Dateinamen (z. B. `instrukcja`, `obslugi` ➡️ Polnisch | `manuel`, `utilisation` ➡️ Französisch | `operating manual` ➡️ Englisch).
3.  **Discovery Engine Metadaten-Fallback:** Erst wenn im URI-Pfad kein eindeutiger Sprachhinweis existiert, wird das Metadatenfeld `language` ausgewertet.
4.  **Konversationssprachen-Erkennung:** Das Backend ermittelt über eine leichtgewichtige Stoppwort-Analyse (`detectConversationLanguage`) die Sprache der Frage/Antwort und filtert unpassende Quellen hart aus (`language !== convLang`).

---

## 📂 4. Quellen-Aufteilung & Visualisierung (UI/UX)

Um die Benutzeroberfläche extrem übersichtlich und benutzerfreundlich zu halten, werden genutzte Quellen visuell getrennt:

### Sektionen unter der Antwort
Die Liste der genutzten Quellen wird im Frontend anhand des URL-Typs segmentiert:
*   **Gefundene Dokumente (PDFs):** Nur echte PDF-Dokumente aus der GCS-Ablage, gruppiert nach Dokumententyp (z. B. Betriebsanleitungen, Broschüren) in **Klaro-Blau**.
*   **Gefundene Weblinks (Klaro Website):** Direkte, voll-qualifizierte Links auf die offizielle Webseite in einem modernen **Grün mit Globus/Extern-Link-Icon**.

### Fußnoten (Inline-Zitate)
Die kleinen hochgestellten Fußnoten-Badges `[1]` im Antworttext zeigen sofort den Link-Typ:
*   **PDF-Zitate:** Blaues Design, PDF-Symbol beim Hover.
*   **Web-Zitate:** Grünes Design (`web-badge`), Web-Symbol beim Hover.

---

## 📊 5. Token- & Kosten-Monitoring

Da die Such-API die exakten LLM-Token im Payload nicht anzeigt, läuft im Backend ein Heuristik-Kalkulator, der die Tokenmengen schätzt:

*   **Heuristik:** 1 Wort/Zahl ≈ 1,33 Token (berechnet als `Zeichenlänge / 4`).
*   **Echtzeit-Berechnung:**
    *   **Prompt-Token:** Frage-Länge + Textlänge aller geladenen RAG-Kontext-Passagen.
    *   **Antwort-Token:** Textlänge des generierten Antwort-Textes.
*   **Preiskalkulation (Gemini 3.1 Pro Heuristiken in EUR):**
    *   *Input:* ~1,15 € pro 1.000.000 Token.
    *   *Output:* ~4,60 € pro 1.000.000 Token.
*   **Visualisierung:** Eine Echtzeit-Karte **"Token-Verbrauch"** in der Sidebar zeigt die Token-Aufteilung und die akkumulierten Kosten in Euro (z. B. `0,00124 €`) an.

---

## ⚙️ 6. Deployment & Entwicklung

### Lokale Ausführung
1.  Backend starten: `npm start` (Port 8080)
2.  Frontend starten: `npm run dev` im Ordner `/frontend` (Port 5173, mit HMR)

### Produktiver Build
Der Befehl `npm run build` im Hauptverzeichnis kompiliert das Frontend in den Ordner `frontend/dist`. Das Backend liefert diese fertigen Assets über Express aus:
```javascript
app.use(express.static(path.join(__dirname, 'frontend/dist')));
```

### Git-Verhaltenskodex
*   Änderungen an Code und Styling immer semantisch commiten (z. B. `feat: ...`, `fix: ...`).
*   Nach Code-Anpassungen im Frontend stets `npm run build` ausführen, um `frontend/dist` für das Express-Backend aktuell zu halten.
