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
const firebaseAdminOptions = {};

// Bevorzuge lokal die key.json, um Konflikte mit globalen System-Umgebungsvariablen zu vermeiden
if (fs.existsSync('key.json')) {
    clientOptions.keyFilename = 'key.json';
    storageOptions.keyFilename = 'key.json';
    
    // Firebase Admin mit lokalem Key initialisieren
    const keyData = JSON.parse(fs.readFileSync('key.json', 'utf8'));
    firebaseAdminOptions.credential = admin.cert(keyData);
    console.log('Verwende lokale key.json für Authentifizierung.');
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    clientOptions.keyFilename = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    storageOptions.keyFilename = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    firebaseAdminOptions.credential = admin.applicationDefault();
    console.log('Verwende GOOGLE_APPLICATION_CREDENTIALS aus Umgebungsvariablen.');
} else {
    firebaseAdminOptions.credential = admin.applicationDefault();
    console.log('Keine explizite Key-Datei gefunden. Verwende Standard-Dienstkonto (Application Default Credentials).');
}

// Firebase Admin SDK initialisieren
try {
    admin.initializeApp(firebaseAdminOptions);
    console.log('Firebase Admin SDK erfolgreich initialisiert.');
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

// Leichtgewichtige Stoppwort-Analyse zur Spracherkennung der Konversation
function detectConversationLanguage(message, answerText, references) {
    const textToAnalyze = ((answerText || "") + " " + (message || "")).toLowerCase();
    
    const germanWords = /\b(ich|ist|und|der|die|das|ein|eine|mit|auf|für|von|im|in|nicht|zu|es|wir|sie|sind|vor|aus|eine|einem|einer|eines|bei|nach|oder|um|zur|zum|wie|an|als)\b/g;
    const englishWords = /\b(the|and|a|an|of|to|in|is|you|that|it|he|was|for|on|are|as|with|his|they|i|this|at|by|be|from|or|shall|will|would|can)\b/g;
    const frenchWords = /\b(le|la|les|et|en|un|une|est|dans|pour|qui|que|sur|avec|par|des|du|d|l|sont|pour|pourrait|aux)\b/g;

    let deCount = (textToAnalyze.match(germanWords) || []).length;
    let enCount = (textToAnalyze.match(englishWords) || []).length;
    let frCount = (textToAnalyze.match(frenchWords) || []).length;

    // Fallback: Wenn kein Text erkannt wurde, prüfen wir die Dokumenten-Sprachen
    if (deCount === 0 && enCount === 0 && frCount === 0 && references) {
        let refLangs = { de: 0, en: 0, fr: 0 };
        for (const ref of references) {
            const lang = getMetadataField(ref.chunkInfo?.documentMetadata?.structData, 'language');
            if (lang && refLangs[lang] !== undefined) {
                refLangs[lang]++;
            }
        }
        if (refLangs.de > refLangs.en && refLangs.de > refLangs.fr) return "de";
        if (refLangs.en > refLangs.de && refLangs.en > refLangs.fr) return "en";
        if (refLangs.fr > refLangs.de && refLangs.fr > refLangs.en) return "fr";
    }

    if (deCount >= enCount && deCount >= frCount) return 'de';
    if (enCount > deCount && enCount >= frCount) return 'en';
    if (frCount > deCount && frCount > enCount) return 'fr';

    return 'de'; // Standard-Fallback
}

const client = new ConversationalSearchServiceClient(clientOptions);

const PROJECT_ID = 'klaro-475913';
const LOCATION = 'global';
const ENGINE_ID = 'klaro-search_1761300255655';

// Health-Check Endpoint für Cloud Run und lokale Tests
app.get('/', (req, res) => {
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

            // Sprache mit robustem Fallback aus URI auslesen
            let language = getMetadataField(structData, 'language');
            if (!language) {
                if (uri.includes('-de-') || uri.includes('/de/')) language = 'de';
                else if (uri.includes('-en-') || uri.includes('/en/')) language = 'en';
                else if (uri.includes('-fr-') || uri.includes('/fr/')) language = 'fr';
                else language = 'de';
            }

            // Dokumententyp auslesen
            let documentType = getMetadataField(structData, 'document_type');
            if (!documentType) {
                if (uri.includes('/betriebsanleitung/')) documentType = 'betriebsanleitung';
                else if (uri.includes('/broschuere/')) documentType = 'broschuere';
                else if (uri.includes('/datenblatt/')) documentType = 'datenblatt';
                else if (uri.includes('/montageanleitung/')) documentType = 'montageanleitung';
                else if (uri.includes('/zertifikat/')) documentType = 'zertifikat';
                else if (uri.includes('/zeichnung/')) documentType = 'zeichnung';
                else documentType = 'sonstiges';
            }

            // STRIKTER FILTER: Nur Dokumente in der aktuellen Konversationssprache anzeigen
            if (language !== convLang) {
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

        // 1. Suche in den Top-Level-Referenzen
        if (response.answer?.references) {
            for (const ref of response.answer.references) {
                const uri = ref.documentMetadata?.uri;
                const title = ref.documentMetadata?.title;
                addSource(uri, title || "Dokument", ref.documentMetadata?.structData);
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
        const signedReferences = response.answer?.references 
            ? await Promise.all(response.answer.references.map(async (ref) => {
                const refCopy = JSON.parse(JSON.stringify(ref));
                const metadata = refCopy.chunkInfo?.documentMetadata;
                if (metadata) {
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

        res.json({ 
            reply: response.answer?.answerText || "Keine Antwort.",
            session: response.session?.name || null,
            sources: signedSources,
            citations: response.answer?.citations || [],
            references: signedReferences
        });

    } catch (error) {
        console.error('FEHLER_DETAILS:', error);
        res.status(500).json({ error: error.message, stack: error.stack });
    }
});

// Dynamischer Port (wichtig für Cloud Run, Fallback auf 8080 für lokal)
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));