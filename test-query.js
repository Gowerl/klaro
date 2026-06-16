require('dotenv').config();
const { ConversationalSearchServiceClient } = require('@google-cloud/discoveryengine').v1beta;
const fs = require('fs');

const clientOptions = {
    apiEndpoint: 'discoveryengine.googleapis.com'
};

if (fs.existsSync('key.json')) {
    clientOptions.keyFilename = 'key.json';
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    clientOptions.keyFilename = process.env.GOOGLE_APPLICATION_CREDENTIALS;
}

const client = new ConversationalSearchServiceClient(clientOptions);

const PROJECT_ID = 'klaro-475913';
const LOCATION = 'global';
const ENGINE_ID = 'klaro-search_1761300255655';

async function test() {
    try {
        const servingConfig = `projects/${PROJECT_ID}/locations/${LOCATION}/collections/default_collection/engines/${ENGINE_ID}/servingConfigs/default_serving_config`;

        const request = {
            servingConfig: servingConfig,
            query: { text: "SBR-Verfahren" },
            answerGenerationSpec: {
                includeCitations: true
            }
        };

        console.log("Sende Test-Anfrage...");
        const [response] = await client.answerQuery(request);
        
        console.log("\n=== ANSWER TEXT ===");
        console.log(response.answer?.answerText);

        console.log("\n=== REFERENCES (TOP 2) ===");
        if (response.answer?.references) {
            console.log(JSON.stringify(response.answer.references.slice(0, 2), null, 2));
        } else {
            console.log("Keine References vorhanden.");
        }

        console.log("\n=== SEARCH RESULTS STEPS ===");
        const searchResults = response.answer?.steps?.[0]?.actions?.[0]?.observation?.searchResults;
        if (searchResults) {
            console.log(JSON.stringify(searchResults.slice(0, 1), null, 2));
        } else {
            console.log("Keine Search Results in Steps.");
        }

    } catch (e) {
        console.error("Fehler:", e);
    }
}

test();
