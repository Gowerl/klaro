require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { ConversationalSearchServiceClient } = require('@google-cloud/discoveryengine').v1beta;

const app = express();
app.use(express.json());
app.use(cors());

const fs = require('fs');
const { Storage } = require('@google-cloud/storage');
const admin = require('firebase-admin');
const { getAuth } = require('firebase-admin/auth');

// Google Discovery Engine Client & Storage Client initialisieren mit robustem Anmelde-Fallback
const clientOptions = {
    apiEndpoint: 'discoveryengine.googleapis.com'
};

const storageOptions = {};
const firebaseAdminOptions = {
    projectId: process.env.FIREBASE_PROJECT_ID || 'klaro-app-b223e'
};

// Falls der Key als Umgebungsvariable im Deployment hinterlegt ist, schreiben wir ihn temporär in key.json
if (process.env.GOOGLE_CREDENTIALS_JSON) {
    try {
        fs.writeFileSync('key.json', process.env.GOOGLE_CREDENTIALS_JSON, 'utf8');
        console.log('key.json wurde erfolgreich aus der Umgebungsvariable GOOGLE_CREDENTIALS_JSON erstellt.');
    } catch (err) {
        console.error('Fehler beim Schreiben der key.json aus der Umgebungsvariable:', err);
    }
}

// Bevorzuge lokal die key.json, um Konflikte mit globalen System-Umgebungsvariablen zu vermeiden
if (fs.existsSync('key.json')) {
    clientOptions.keyFilename = 'key.json';
    storageOptions.keyFilename = 'key.json';
    console.log('Verwende lokale key.json für Authentifizierung der Google-APIs.');
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    clientOptions.keyFilename = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    storageOptions.keyFilename = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    console.log('Verwende GOOGLE_APPLICATION_CREDENTIALS aus Umgebungsvariablen.');
} else {
    console.log('Keine explizite Key-Datei gefunden. Verwende Standard-Dienstkonto.');
}

// Firebase Admin SDK initialisieren
try {
    admin.initializeApp(firebaseAdminOptions);
    console.log(`Firebase Admin SDK erfolgreich initialisiert für Projekt: ${firebaseAdminOptions.projectId}`);
} catch (error) {
    console.error('Fehler beim Initialisieren des Firebase Admin SDK:', error);
}

const storage = new Storage(storageOptions);

// Middleware zur Absicherung von Routen mit Firebase Authentication
const verifyToken = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            console.log('Abgewiesen: Kein gültiger Authorization-Header vorhanden.');
            return res.status(401).json({ error: 'Nicht autorisiert. Bitte melde dich an.' });
        }

        const idToken = authHeader.split('Bearer ')[1];
        const decodedToken = await getAuth().verifyIdToken(idToken);
        
        // Verifizierten Benutzer an das Request-Objekt hängen
        req.user = decodedToken;
        console.log(`Benutzer erfolgreich verifiziert: ${decodedToken.email}`);
        next();
    } catch (error) {
        console.error('Token-Verifizierungsfehler:', error.message);
        return res.status(401).json({ error: 'Ungültiges oder abgelaufenes Authentifizierungs-Token.' });
    }
};

// GCS-URI parsen, um Bucket-Name und Objektpfad zu ermitteln
function parseGcsUri(uri) {
    if (!uri) return null;
    
    let bucketName = '';
    let objectName = '';
    
    if (uri.startsWith('gs://')) {
        const parts = uri.replace('gs://', '').split('/');
        bucketName = parts[0];
        objectName = parts.slice(1).join('/');
    } else if (uri.startsWith('https://storage.googleapis.com/')) {
        const parts = uri.replace('https://storage.googleapis.com/', '').split('/');
        bucketName = parts[0];
        objectName = parts.slice(1).join('/');
    } else if (uri.startsWith('https://storage.cloud.google.com/')) {
        const parts = uri.replace('https://storage.cloud.google.com/', '').split('/');
        bucketName = parts[0];
        objectName = parts.slice(1).join('/');
    } else {
        return null;
    }
    
    return { bucketName, objectName };
}

// Generiert eine zeitlich begrenzte Signed URL (15 Minuten gültig) für ein privates GCS-Objekt
async function generateSignedUrl(gcsUri) {
    try {
        const parsed = parseGcsUri(gcsUri);
        if (!parsed) return gcsUri; // Fallback: Wenn es keine GCS-URI ist, Original zurückgeben
        
        const { bucketName, objectName } = parsed;
        
        const [url] = await storage
            .bucket(bucketName)
            .file(objectName)
            .getSignedUrl({
                version: 'v4',
                action: 'read',
                expires: Date.now() + 15 * 60 * 1000, // 15 Minuten Gültigkeit
            });
            
        return url;
    } catch (error) {
        console.error(`Fehler bei der Signed-URL Generierung für ${gcsUri}:`, error);
        return gcsUri; // Fallback: Bei Fehler Original-URI zurückgeben
    }
}

// Hilfsfunktion zum Extrahieren von Feldern aus Discovery Engine structData
const getMetadataField = (structData, fieldName) => {
    if (!structData) return null;
    if (structData.fields && structData.fields[fieldName]) {
        const field = structData.fields[fieldName];
        return field.stringValue || field.boolValue || field.numberValue || null;
    }
    return structData[fieldName] || null;
};

// Extrahierung der Sprache aus Metadaten, Titel und URI mit robustem Fallback
const extractLanguage = (uri, title, structData) => {
    let language = null;
    const lowerUri = uri ? uri.toLowerCase() : '';
    const lowerTitle = title ? title.toLowerCase() : '';

    // 1. Spezifische Phrasen-Erkennung im URI oder Titel (höchste Priorität, da absolut eindeutig)
    if (lowerUri.includes('instrukcja') || lowerTitle.includes('instrukcja') || lowerUri.includes('obslugi') || lowerTitle.includes('obslugi')) {
        return 'pl'; // Polnisch
    }
    if (lowerUri.includes('manuel') || lowerTitle.includes('manuel') || lowerUri.includes('utilisation') || lowerTitle.includes('utilisation') || lowerUri.includes('exploitation') || lowerTitle.includes('exploitation') || lowerUri.includes('d\'emploi') || lowerTitle.includes('d\'emploi') || lowerUri.includes('commande') || lowerTitle.includes('commande')) {
        return 'fr'; // Französisch
    }
    if (lowerUri.includes('instrucciones') || lowerTitle.includes('instrucciones') || lowerUri.includes('ligeros') || lowerTitle.includes('ligeros') || lowerUri.includes('separador') || lowerTitle.includes('separador')) {
        return 'es'; // Spanisch
    }
    if (lowerUri.includes('manuale') || lowerTitle.includes('manuale') || lowerUri.includes('distruzioni') || lowerTitle.includes('distruzioni') || lowerUri.includes('controllo') || lowerTitle.includes('controllo')) {
        return 'it'; // Italienisch
    }
    if (lowerUri.includes('operating_manual') || lowerTitle.includes('operating manual') || lowerUri.includes('information_sheet') || lowerTitle.includes('information sheet')) {
        return 'en'; // Englisch
    }

    // 2. Explizite Sprach-Tags im URI oder Titel prüfen (z.B. -de-, -en-, -fr-, -es-, -it-, -po-, -pl-)
    if (uri) {
        if (lowerUri.match(/[-/_]de[-/_]/) || lowerUri.includes('/de/')) {
            return 'de';
        }
        if (lowerUri.match(/[-/_]en[-/_]/) || lowerUri.includes('/en/')) {
            return 'en';
        }
        if (lowerUri.match(/[-/_]fr[-/_]/) || lowerUri.includes('/fr/')) {
            return 'fr';
        }
        if (lowerUri.match(/[-/_]es[-/_]/) || lowerUri.includes('/es/')) {
            return 'es';
        }
        if (lowerUri.match(/[-/_]it[-/_]/) || lowerUri.includes('/it/')) {
            return 'it';
        }
        if (lowerUri.match(/[-/_]pl[-/_]/) || lowerUri.match(/[-/_]po[-/_]/) || lowerUri.includes('/pl/') || lowerUri.includes('/po/')) {
            return 'pl'; // Polnisch / "po" als polnischer Dateiname-Code
        }
        if (lowerUri.match(/[-/_]nl[-/_]/) || lowerUri.includes('/nl/')) {
            return 'nl'; // Niederländisch
        }
        if (lowerUri.match(/[-/_]pt[-/_]/) || lowerUri.includes('/pt/')) {
            return 'pt'; // Portugiesisch
        }
        if (lowerUri.match(/[-/_]hr[-/_]/) || lowerUri.includes('/hr/')) {
            return 'hr'; // Kroatisch
        }
        if (lowerUri.match(/[-/_]ro[-/_]/) || lowerUri.includes('/ro/')) {
            return 'ro'; // Rumänisch
        }
    }

    // 3. Wenn über spezifische Muster nichts gefunden wurde: Metadaten aus Discovery Engine prüfen
    let metaLanguage = getMetadataField(structData, 'language');
    if (metaLanguage) {
        metaLanguage = metaLanguage.toLowerCase();
        if (metaLanguage === 'german' || metaLanguage === 'de-de' || metaLanguage === 'de') return 'de';
        if (metaLanguage === 'english' || metaLanguage === 'en-us' || metaLanguage === 'en-gb' || metaLanguage === 'en') return 'en';
        if (metaLanguage === 'french' || metaLanguage === 'fr-fr' || metaLanguage === 'fr') return 'fr';
        if (metaLanguage === 'spanish' || metaLanguage === 'es-es' || metaLanguage === 'es') return 'es';
        if (metaLanguage === 'italian' || metaLanguage === 'it-it' || metaLanguage === 'it') return 'it';
        if (metaLanguage === 'polish' || metaLanguage === 'pl-pl' || metaLanguage === 'pl') return 'pl';
        if (metaLanguage === 'dutch' || metaLanguage === 'nl-nl' || metaLanguage === 'nl') return 'nl';
        return metaLanguage;
    }

    // 4. Fallback auf typische deutsche Signalwörter, falls gar nichts geholfen hat
    if (lowerUri.includes('deutsch') || lowerUri.includes('originalbetriebsanleitung') || lowerUri.includes('betriebsanleitung') || lowerUri.includes('montageanleitung') || lowerUri.includes('datenblatt') || lowerUri.includes('broschuere') || lowerUri.includes('infoblatt') || lowerTitle.includes('hauptbroschuere')) {
        return 'de';
    }

    return null;
};

// Leichtgewichtige Stoppwort-Analyse zur Spracherkennung der Konversation
function detectConversationLanguage(message, answerText, references) {
    const textToAnalyze = ((answerText || "") + " " + (message || "")).toLowerCase();
    
    const germanWords = /\b(ich|ist|und|der|die|das|ein|eine|mit|auf|für|von|im|in|nicht|zu|es|wir|sie|sind|vor|aus|eine|einem|einer|eines|bei|nach|oder|um|zur|zum|wie|an|als)\b/g;
    const englishWords = /\b(the|and|a|an|of|to|in|is|you|that|it|he|was|for|on|are|as|with|his|they|i|this|at|by|be|from|or|shall|will|would|can)\b/g;
    const frenchWords = /\b(le|la|les|et|en|un|une|est|dans|pour|qui|que|sur|avec|par|des|du|d|l|sont|pour|pourrait|aux)\b/g;
    const spanishWords = /\b(el|la|los|las|un|una|unos|unas|y|en|de|que|es|son|para|con|por|un|una|del|al|se|su|sus)\b/g;
    const italianWords = /\b(il|la|i|gli|le|un|una|e|in|di|che|è|sono|per|con|da|del|al|se|su|suo|sua)\b/g;

    let deCount = (textToAnalyze.match(germanWords) || []).length;
    let enCount = (textToAnalyze.match(englishWords) || []).length;
    let frCount = (textToAnalyze.match(frenchWords) || []).length;
    let esCount = (textToAnalyze.match(spanishWords) || []).length;
    let itCount = (textToAnalyze.match(italianWords) || []).length;

    // Fallback: Wenn kein Text erkannt wurde, prüfen wir die Dokumenten-Sprachen
    if (deCount === 0 && enCount === 0 && frCount === 0 && esCount === 0 && itCount === 0 && references) {
        let refLangs = { de: 0, en: 0, fr: 0, es: 0, it: 0, pl: 0 };
        for (const ref of references) {
            const metadata = ref.chunkInfo?.documentMetadata;
            if (metadata) {
                const lang = extractLanguage(metadata.uri, metadata.title, metadata.structData);
                if (lang && refLangs[lang] !== undefined) {
                    refLangs[lang]++;
                }
            }
        }
        const sortedLangs = Object.entries(refLangs).sort((a, b) => b[1] - a[1]);
        if (sortedLangs[0] && sortedLangs[0][1] > 0) {
            return sortedLangs[0][0];
        }
    }

    const maxCount = Math.max(deCount, enCount, frCount, esCount, itCount);
    if (maxCount === 0) return 'de'; // Standard-Fallback
    
    if (deCount === maxCount) return 'de';
    if (enCount === maxCount) return 'en';
    if (frCount === maxCount) return 'fr';
    if (esCount === maxCount) return 'es';
    if (itCount === maxCount) return 'it';

    return 'de'; // Standard-Fallback
}

const client = new ConversationalSearchServiceClient(clientOptions);

const PROJECT_ID = 'klaro-475913';
const LOCATION = 'global';
const ENGINE_ID = 'klaro-search_1761300255655';

const path = require('path');

// Statische Dateien des gebauten Frontends ausliefern
app.use(express.static(path.join(__dirname, 'frontend/dist')));

// Health-Check Endpoint für Cloud Run und lokale Tests
app.get('/api/health', (req, res) => {
    res.status(200).send('KLARO Vertex Backend läuft!');
});

app.post('/api/chat', verifyToken, async (req, res) => {
    try {
        const { message, sessionId } = req.body;
        
        // Wir bauen den Pfad exakt so auf, wie das offizielle SDK es verlangt (für Engines / Apps)
        const servingConfig = `projects/${PROJECT_ID}/locations/${LOCATION}/collections/default_collection/engines/${ENGINE_ID}/servingConfigs/default_serving_config`;

        const request = {
            servingConfig: servingConfig,
            query: { text: message || "Hallo" },
            answerGenerationSpec: {
                includeCitations: true // Aktiviert Zitate und Quellennachweise mit Indizes
            }
        };

        if (sessionId) {
            request.session = sessionId;
        }

        console.log("Sende Anfrage an Pfad:", servingConfig);
        const [response] = await client.answerQuery(request);
        
        const convLang = detectConversationLanguage(message, response.answer?.answerText, response.answer?.references);
        console.log(`Erkannte Konversationssprache: ${convLang}`);

        // Quellen (PDFs/Dokumente) robust extrahieren
        const sources = [];
        const seenUris = new Set();

        const addSource = (uri, title, structData) => {
            if (!uri || seenUris.has(uri)) return;

            // Sprache mit robustem Fallback auslesen (Standard: de)
            const language = extractLanguage(uri, title, structData) || 'de';

            // Dokumententyp auslesen
            let documentType = getMetadataField(structData, 'document_type');
            if (!documentType) {
                const lowerUri = uri.toLowerCase();
                if (lowerUri.includes('/betriebsanleitung/')) documentType = 'betriebsanleitung';
                else if (lowerUri.includes('/broschuere/')) documentType = 'broschuere';
                else if (lowerUri.includes('/datenblatt/')) documentType = 'datenblatt';
                else if (lowerUri.includes('/montageanleitung/')) documentType = 'montageanleitung';
                else if (lowerUri.includes('/zertifikat/')) documentType = 'zertifikat';
                else if (lowerUri.includes('/zeichnung/')) documentType = 'zeichnung';
                else if (lowerUri.includes('klaro.de') || lowerUri.includes('klaro.at') || lowerUri.includes('klaro.eu') || lowerUri.includes('/web/') || !lowerUri.endsWith('.pdf')) {
                    documentType = 'website';
                }
                else documentType = 'sonstiges';
            }

            // STRIKTER FILTER: Nur Dokumente in der aktuellen Konversationssprache anzeigen
            if (language !== convLang) {
                console.log(`Filtere aus (Sprache ${language} ungleich Konversationssprache ${convLang}): ${uri}`);
                return;
            }

            seenUris.add(uri);
            sources.push({ 
                title, 
                uri,
                language,
                documentType
            });
        };

        // 1. Suche in den Top-Level-Referenzen (korrigiert auf chunkInfo.documentMetadata)
        if (response.answer?.references) {
            for (const ref of response.answer.references) {
                const metadata = ref.chunkInfo?.documentMetadata;
                if (metadata) {
                    const uri = metadata.uri;
                    const title = metadata.title;
                    addSource(uri, title || "Dokument", metadata.structData);
                }
            }
        }

        // 2. Suche in den Search-Result-Schritten (bei RAG / AI Applications der gängigste Ort)
        const searchResults = response.answer?.steps?.[0]?.actions?.[0]?.observation?.searchResults;
        if (searchResults) {
            for (const result of searchResults) {
                const uri = result.uri || result.structData?.fields?.public_url?.stringValue || result.structData?.fields?.url?.stringValue;
                let title = result.structData?.fields?.document_title?.stringValue || result.title;
                
                if (!title || title === "Untitled" || title === "untitled") {
                    title = uri ? uri.split('/').pop().replace(/_/g, ' ').replace('.pdf', '') : "Dokument";
                }
                
                addSource(uri, title, result.structData);
            }
        }

        // Wandle die URIs der gefilterten Quellen in zeitlich begrenzte Signed URLs um
        const signedSources = await Promise.all(sources.map(async (src) => {
            const signedUri = await generateSignedUrl(src.uri);
            return {
                ...src,
                uri: signedUri
            };
        }));

        // Wandle alle URIs in den Referenzen (für Inline-Zitate [1], [2], etc.) ebenfalls in Signed URLs um
        // Filtere zudem Inline-Zitate heraus, die nicht zur Konversationssprache passen
        const signedReferences = response.answer?.references 
            ? await Promise.all(response.answer.references.map(async (ref) => {
                const refCopy = JSON.parse(JSON.stringify(ref));
                const metadata = refCopy.chunkInfo?.documentMetadata;
                if (metadata) {
                    const lang = extractLanguage(metadata.uri, metadata.title, metadata.structData) || 'de';
                    if (lang !== convLang) {
                        return null; // Zitat-Referenz ausblenden, falls Sprache ungleich Konversationssprache
                    }
                    if (metadata.uri) {
                        metadata.uri = await generateSignedUrl(metadata.uri);
                    }
                    if (metadata.structData?.fields?.public_url?.stringValue) {
                        metadata.structData.fields.public_url.stringValue = await generateSignedUrl(metadata.structData.fields.public_url.stringValue);
                    }
                    if (metadata.structData?.fields?.url?.stringValue) {
                        metadata.structData.fields.url.stringValue = await generateSignedUrl(metadata.structData.fields.url.stringValue);
                    }
                }
                return refCopy;
              }))
            : [];

        const queryTokens = Math.ceil((message || "").length / 4);
        const replyTokens = Math.ceil((response.answer?.answerText || "").length / 4);
        
        let contextText = "";
        if (response.answer?.references) {
            for (const ref of response.answer.references) {
                contextText += (ref.chunkInfo?.content || "") + " ";
            }
        }
        const contextTokens = Math.ceil(contextText.length / 4);
        
        const totalInputTokens = queryTokens + contextTokens;
        
        // Gemini Pro Kosten-Heuristik (EUR):
        // Input: ~1.15 € / 1 Mio. Token (0.00000115 € / Token)
        // Output: ~4.60 € / 1 Mio. Token (0.00000460 € / Token)
        const costEUR = (totalInputTokens * 0.00000115) + (replyTokens * 0.00000460);

        const estimatedTokens = {
            query: queryTokens,
            reply: replyTokens,
            context: contextTokens,
            total: queryTokens + replyTokens + contextTokens,
            cost: costEUR
        };

        res.json({ 
            reply: response.answer?.answerText || "Keine Antwort.",
            session: response.session?.name || null,
            sources: signedSources,
            citations: response.answer?.citations || [],
            references: signedReferences,
            tokens: estimatedTokens
        });

    } catch (error) {
        console.error('FEHLER_DETAILS:', error);
        res.status(500).json({ error: error.message, stack: error.stack });
    }
});

// Fallback für alle anderen Routen, um die React Single Page Application auszuliefern
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend/dist', 'index.html'));
});

// Dynamischer Port (wichtig für Cloud Run, Fallback auf 8080 für lokal)
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));