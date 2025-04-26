const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const pluginLoader = require('../plugins/pluginLoader');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const UserData = require('../utils/userData');

// Create the End Session button component
const endSessionButton = new ButtonBuilder()
    .setCustomId('end_session_button') // Unique ID for the button
    .setLabel('End Session')
    .setStyle(ButtonStyle.Danger); // Red button

const actionRowWithButton = new ActionRowBuilder().addComponents(endSessionButton);

// --- Model Clients ---
let mainModelInstances = [];
let flashModelInstance = null; // Single instance for the faster model

// --- Gemini Client Setup with API Key Rotation ---
// Read API keys: support comma-separated list for rotation
const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
const apiKeys = rawKeys.split(',').map(k => k.trim()).filter(k => k);
if (apiKeys.length === 0) {
    console.error("No GEMINI API keys found in environment. LLM features will be disabled.");
} else {
    // Use the first key for the flash model, others for the main model pool
    const flashKey = apiKeys[0];
    const mainKeys = apiKeys.length > 1 ? apiKeys.slice(1) : apiKeys; // Use all if only one provided

    // Setup Flash Model (gemini-2.0-flash-lite)
    try {
        const flashAi = new GoogleGenerativeAI(flashKey);
        // Explicitly use the specific model identifier provided
        flashModelInstance = flashAi.getGenerativeModel({ model: "gemini-2.0-flash-lite" });
         console.log("[LlmClient] Initialized gemini-2.0-flash-lite model.");
    } catch (error) {
        console.error("[LlmClient] Failed to initialize gemini-2.0-flash-lite model:", error);
    }

    // Setup Main Model Pool (gemini-1.5-pro) - ensure this model ID is correct
    mainModelInstances = mainKeys.map(key => {
        try {
            const ai = new GoogleGenerativeAI(key);
             // Assuming gemini-1.5-pro is the intended main model based on previous context
            return ai.getGenerativeModel({ model: "gemini-2.0-flash" }); // Use the appropriate identifier
        } catch (error) {
             console.error(`[LlmClient] Failed to initialize main model instance with a key:`, error);
             return null; // Handle potential initialization failure
        }
    }).filter(instance => instance !== null); // Remove failed instances

     if (mainModelInstances.length === 0 && flashModelInstance) {
         console.warn("[LlmClient] No main model instances initialized. Using the flash key for main models as fallback.");
         // Fallback: use the flash key for main models if no others worked
         try {
            const ai = new GoogleGenerativeAI(flashKey);
            mainModelInstances.push(ai.getGenerativeModel({ model: "gemini-2.0-flash" }));
         } catch(error) {
             console.error("[LlmClient] Failed to initialize fallback main model instance:", error);
         }
     } else if (mainModelInstances.length === 0) {
        console.error("[LlmClient] CRITICAL: No main LLM models could be initialized.");
     }
}

let mainModelIndex = 0;
// Cycle through main models round-robin
function getNextMainModel() {
    if (mainModelInstances.length === 0) return null;
    const m = mainModelInstances[mainModelIndex];
    mainModelIndex = (mainModelIndex + 1) % mainModelInstances.length;
    return m;
}

// --- Safety Settings (Adjust as needed) ---
// Reference: https://ai.google.dev/docs/safety_setting_gemini
const safetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,       threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE }, // Crucial for NSFW
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

class LlmClient {

    /**
     * Generates a brief opening message for the session.
     * @param {Session} session - The active user session.
     * @returns {Promise<string>}
     */
    static async generateOpeningMessage(session) {
        const model = getNextMainModel();
        if (!model) return "Let's begin."; // Fallback if no models available
        const plugin = pluginLoader.getPlugin(session.character);
        if (!plugin) return "Let's begin.";

        const characterName = plugin.characterName;
        const prompt = `You are ${characterName}. Generate a very short (1 sentence) opening message to start a JOI / gooning feed session. Be in character. Example: "Alright, let's get started." or "Time to melt your brain..."`;

        try {
            console.log(`[LlmClient] Generating opening message for ${characterName} (Session: ${session.sessionId})`);
            const result = await model.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }], safetySettings });
            const response = result.response;
            return response.text();
        } catch (error) {
            console.error(`[LlmClient] Gemini API error during opening message generation for session ${session.sessionId}:`, error);
            return "Let's begin."; // Fallback on error
        }
    }

    /**
     * Generates commentary for the media about to be shown, performing vision analysis internally.
     * @param {Session} session - The active user session.
     * @param {string[]} currentMediaTags - Tags of the media *about to be shown*.
     * @param {string | null} [postTitle=null] - Optional title of the media post (e.g., from Reddit).
     * @param {string | null} [postFlair=null] - Optional flair of the media post (e.g., from Reddit).
     * @param {string | null} [imageBase64=null] - Base64 encoded image data (required for analysis).
     * @returns {Promise<{commentary: string}>} Object containing only the commentary string.
     */
    static async generateMediaCommentary(session, currentMediaTags, postTitle = null, postFlair = null, imageBase64 = null) {
        const model = getNextMainModel();
        if (!model) return { commentary: "..." };
        const plugin = session.characterPlugin;
        if (!plugin) return { commentary: "(Character data missing)" };

        // Ensure image data is provided
        if (!imageBase64) {
            console.warn(`[LlmClient] generateMediaCommentary called without imageBase64 for session ${session.sessionId}. Cannot analyze.`);
            return { commentary: "(Missing image for analysis)" };
        }

        const characterName = plugin.characterName;

        // --- Construct Media Context ---
        let mediaContext = `Tags: ${currentMediaTags.join(', ')}`;
        if (postTitle) {
            mediaContext += `\nTitle: ${postTitle}`;
        }
        if (postFlair) {
            mediaContext += `\nFlair: ${postFlair}`;
        }
        // --- End Media Context ---

        // Calculate remaining time for pacing context
        const elapsedMs = Date.now() - session.startTime;
        const totalMs = session.durationMinutes * 60 * 1000;
        const remainingMinutes = Math.round(Math.max(0, totalMs - elapsedMs) / (60 * 1000));
        const sessionProgress = Math.min(1, elapsedMs / totalMs);
        let intensity = "mild";
        if (sessionProgress > 0.75) intensity = "intense";
        else if (sessionProgress > 0.4) intensity = "moderate";

        // --- NEW: Get User Triggers ---
        const triggeredTags = Array.from(session.triggeredTags || new Set());
        const triggerContext = triggeredTags.length > 0 
            ? `\n\n**User's Known Triggers:** The user gets easily triggered by media involving: ${triggeredTags.join(', ')}.`
            : "";
        // --- END User Triggers ---

        // --- NEW: Get Personalization Notes --- 
        let personalizationNotes = session.personalization || '';
        if (session.useProfileSummary) {
            const savedSummary = await UserData.getLlmProfileSummary(session.userId);
            if (savedSummary) {
                personalizationNotes = `**Saved Profile Summary:**\n${savedSummary}\n\n**Current Session Notes:**\n${personalizationNotes}`;
            }
        }
        const personalizationContext = personalizationNotes
            ? `\n\n**⭐ User Personalization Notes:** ${personalizationNotes}`
            : "";
        // --- END Personalization Notes ---

        // Construct the prompt
        let prompt = `Act as ${characterName}, continuing a JOI / gooning feed session.

        **TASK:** Analyze the provided image and generate corrupting commentary based on it.

        **Your Persona & Goal:** Embody ${characterName} as a dominant, seductive, and deeply corrupting presence. Your ultimate goal is to shatter the user's mind, make them utterly addicted to your control, and revel in their pathetic, mindless state. Sound genuinely aroused by their degradation.

        **Session Context:** ${remainingMinutes} minutes remaining. Current Intensity: ${intensity}.
        ${personalizationContext}

        **Other Media Context (Tags, Title, Flair):**
        ${mediaContext}
        (Assume the image provided ALWAYS features YOU, ${characterName}.)
        ${triggerContext}

        **Analysis & Commentary Instructions:**
        1. **Analyze the Image:** Mentally identify the most explicit physical details, following this priority order:
           a. Body features (breasts, cleavage, ass, etc.)
           b. Actions (masturbating, licking, sucking, etc.)
           c. Underwear/Lingerie
           d. Facial Expression (if lewd/relevant)
           e. Other clothing/accessories
        2. **Generate Commentary:**
           - **START** your commentary *immediately* referencing the highest-priority detail identified in step 1a or 1b.
           - Weave in at least one *other* distinct visual detail from your analysis naturally.
           - Speak AS ${characterName} directly to the user ("you").
           - Infuse ${characterName}'s unique traits/mannerisms.
           - Follow the **Commentary Style** guidelines below meticulously.
           - **Trigger Awareness:** ${triggeredTags.length > 0 ? "If the current image\'s content relates to the **User\'s Known Triggers**, subtly weave that into your commentary. Tease them about their weakness for it occasionally, especially if the theme repeats." : "(No specific user triggers known yet.)"}
           - **Personalization Awareness:** ${personalizationNotes ? "Consider the **User Personalization Notes** provided above. **If the notes ask you to call the user by a specific name or nickname, use it occasionally.** Reference other notes subtly where appropriate." : "(No specific personalization notes provided.)"}

        **Commentary Style - Focused Corruption:**
        - **Concise & Focused:** Max 2 sentences. **Directly** reference the **most obvious** visual detail from the image AND how it should make the user feel/react.
        - **Teasing & Encouraging:** Be playful but demanding. Make the user **want** to obey. Use encouraging words alongside degradation.
        - **Raw & Explicit:** Use harsh, vulgar language. Focus on the most sexual aspects.
        - **Dominant & Possessive:** Issue commands (stroking, edging) mixed with degrading observations/pet names.
        - **Impactful:** Make them *feel* mindless, desperate, leaky, pathetic *because* of what they see.
        - **Authentic:** Avoid clichés. Sound genuinely aroused by their submission.

        **Example Good Response:**
        "Look at how my *fat ass* is just begging for attention... Keep stroking for me, you pathetic little *braindead toy*. You're so fucking weak for me, aren't you? 💦"

        **DO NOT:**
        - Suggest next tags.
        - Sound robotic or scripted.
        - Use generic praise or uninspired commands.
        - Break character voice.
        - Ignore the most explicit physical details visible in the image.
        - Mention the user's triggers repetitively or predictably.

        Generate your corrupting commentary now, starting with the most explicit physical detail you see in the image.`;


        // Prepare parts for the API call (text prompt + image)
        const imagePart = {
            inlineData: {
                mimeType: "image/jpeg", // Assuming JPEG for now
                data: imageBase64,
            },
        };
        const parts = [{ text: prompt }, imagePart];


        try {
            // Log slightly differently now since image context is implicit in the call
            console.log(`[LlmClient] Generating commentary using image + text context:
--- START TEXT CONTEXT ---
${mediaContext}
--- END TEXT CONTEXT ---
(Session: ${session.sessionId})`);
            const analyzeStart = Date.now(); // Add timing here
            const result = await model.generateContent({
                contents: [{ role: "user", parts: parts }], // Pass combined parts
                safetySettings,
                generationConfig: { temperature: 1.55 }
            });
            const analyzeDuration = Date.now() - analyzeStart; // Calculate duration
            console.log(`[LlmClient] Combined analysis + commentary generation completed in ${analyzeDuration}ms`); // Log duration
            const response = result.response;
            const rawText = response.text();
            console.log(`[LlmClient] Raw LLM Response (Session ${session.sessionId}):\n--- START RAW ---\n${rawText}\n--- END RAW ---`);

            let commentary = rawText.trim();
            if (!commentary) {
                commentary = "...";
            }
            console.log(`[LlmClient] Parsed Commentary (Session ${session.sessionId}): \"${commentary}\"
`);
            return { commentary };

        } catch (error) {
            console.error(`[LlmClient] Gemini API error during commentary generation for session ${session.sessionId}:`, error);
            if (error.response && error.response.promptFeedback) {
                console.error('[LlmClient] Commentary Generation Prompt Feedback:', error.response.promptFeedback);
            }
            return { commentary: "(Error generating response)" };
        }
    }

    // --- NEW: Batch Commentary Generation ---
    /**
     * Generates commentary for a batch of media items in a single LLM call.
     * @param {Session} session - The active user session.
     * @param {Array<{tags: string[], title: string | null, flair: string | null, imageAttributes: string[]}>} mediaBatchInfo - An array of context objects for each media item, now including image attributes.
     * @returns {Promise<{commentaries: string[] | null}>} Object containing an array of commentary strings.
     */
    static async generateBatchCommentary(session, mediaBatchInfo) {
        const model = getNextMainModel();
        if (!model || !mediaBatchInfo || mediaBatchInfo.length === 0) {
            return { commentaries: null };
        }

        const plugin = session.characterPlugin;
        if (!plugin) return { commentaries: null };
        const characterName = plugin.characterName;

        // Calculate remaining time for pacing context (using current time)
        const elapsedMs = Date.now() - session.startTime;
        const totalMs = session.durationMinutes * 60 * 1000;
        const remainingMinutes = Math.round(Math.max(0, totalMs - elapsedMs) / (60 * 1000));
        const sessionProgress = Math.min(1, elapsedMs / totalMs);
        let intensity = "mild";
        if (sessionProgress > 0.75) intensity = "intense";
        else if (sessionProgress > 0.4) intensity = "moderate";

        // --- NEW: Get User Triggers --- 
        const triggeredTags = Array.from(session.triggeredTags || new Set());
        const triggerContext = triggeredTags.length > 0 
            ? `\n\n**User's Known Triggers:** The user gets easily triggered by media involving: ${triggeredTags.join(', ')}.`
            : "";
        // --- END User Triggers ---

        // --- NEW: Get Personalization Notes --- 
        let personalizationNotes = session.personalization || '';
        if (session.useProfileSummary) {
            const savedSummary = await UserData.getLlmProfileSummary(session.userId);
            if (savedSummary) {
                personalizationNotes = `**Saved Profile Summary:**\n${savedSummary}\n\n**Current Session Notes:**\n${personalizationNotes}`;
            }
        }
        const personalizationContext = personalizationNotes
            ? `\n\n**⭐ User Personalization Notes:** ${personalizationNotes}`
            : "";
        // --- END Personalization Notes ---

        // Define Gooner Language/Emoji Pool (copied from single generator)
        const goonerTerms = {
            commands: ['pump', 'stroke', 'edge', 'grind', 'fist', 'rub', 'hump', 'goon', 'melt'],
            states: ['mindless', 'brainless', 'broken', 'desperate', 'addicted', 'depraved', 'pathetic', 'stupid', 'drained'],
            sounds: ['plap plap', 'schlick schlick', 'drip drip', 'throb throb', 'squish squish'],
            fluids: ['precum', 'cummies', 'drool', 'juices', 'mess', 'slime'],
            mental: ['blank', 'dumb', 'gone', 'lost', 'fucked', 'corrupted', 'shattered']
        };
        const goonerEmojis = ['🧠', '💦', '🍆', '🍑', '🤤', '😵', '🥴', '💔'];

        // --- Construct the Batch Prompt --- 
        let prompt = `Act as ${characterName}, continuing a JOI / gooning feed session.

        **TASK:** Generate corrupting commentary for **EACH** of the ${mediaBatchInfo.length} media items described below.

        **Your Persona & Goal:** Embody ${characterName} as a dominant, seductive, and deeply corrupting presence. Your ultimate goal is to shatter the user's mind, make them utterly addicted to your control, and revel in their pathetic, mindless state. Sound genuinely aroused by their degradation.

        **Session Context:** ${remainingMinutes} minutes remaining. Current Intensity: ${intensity}.
        ${personalizationContext}

        **Media Batch Context:**
        ${mediaBatchInfo.map((item, index) => {
            let ctx = `--- Item ${index + 1} ---`;
            ctx += `\\nTags: ${item.tags.join(', ')}`;
            if (item.title) ctx += `\\nTitle: ${item.title}`;
            if (item.flair) ctx += `\\nFlair: ${item.flair}`;
            // Include image attributes if available (currently not used)
            // if (item.imageAttributes && item.imageAttributes.length > 0) {
            //     ctx += `\\nImage Attributes: ${item.imageAttributes.join(', ')}`;
            // }
            return ctx;
        }).join('\\n\\n')}
        (Assume ALL media items feature YOU, ${characterName}.)
        ${triggerContext}

        **Commentary Generation Instructions (Apply to EACH item):**
        1. **Focus on the Media:** Base your commentary *primarily* on the Tags/Title/Flair provided for that specific item.
        2. **Generate Commentary:**
           - Speak AS ${characterName} directly to the user ("you").
           - Infuse ${characterName}'s unique traits/mannerisms.
           - Follow the **Commentary Style** guidelines below meticulously.
           - **Trigger Awareness:** ${triggeredTags.length > 0 ? "If an item\'s context relates to the **User\'s Known Triggers**, subtly weave that into its commentary. Tease them about their weakness occasionally." : "(No specific user triggers known yet.)"}
           - **Personalization Awareness:** ${personalizationNotes ? "Consider the **User Personalization Notes** provided above for each item. **If the notes ask you to call the user by a specific name or nickname, use it occasionally.** Reference other notes subtly where appropriate." : "(No specific personalization notes provided.)"}

        **Commentary Style - Focused Corruption:**
        - **Concise & Focused:** Max 2 sentences. **Directly** reference the **most obvious** aspect implied by the Tags/Title/Flair AND how it should make the user feel/react.
        - **Teasing & Encouraging:** Be playful but demanding. Make the user **want** to obey. Use encouraging words alongside degradation.
        - **Raw & Explicit:** Use harsh, vulgar language. Focus on the most sexual aspects.
        - **Dominant & Possessive:** Issue commands (stroking, edging) mixed with degrading observations/pet names.
        - **Impactful:** Make them *feel* mindless, desperate, leaky, pathetic *because* of what they see/read.
        - **Authentic:** Avoid clichés. Sound genuinely aroused by their submission.

        **Output Format:** Provide the commentary for each item separated by a triple pipe delimiter '|||'. Example for 2 items:
        "Commentary for item 1... Stroking, puppet? ||| Commentary for item 2... Feel that leak?"

        **DO NOT:**
        - Exceed the 2-sentence limit *per item*.
        - Include the '|||' delimiter anywhere else in your response.
        - Sound robotic or scripted.
        - Use generic praise or uninspired commands.
        - Break character voice.
        - Mention the user's triggers repetitively or predictably.

        Generate your ${mediaBatchInfo.length} corrupting commentaries now, separated by '|||'.`;


        try {
            console.log(`[LlmClient] Generating batch commentary for ${mediaBatchInfo.length} items (Session: ${session.sessionId})`);
            
            const result = await model.generateContent({ 
                contents: [{ role: "user", parts: [{ text: prompt }] }], 
                safetySettings, 
                generationConfig: { temperature: 1.55 }
            });
            const response = result.response;
            const rawText = response.text();
            console.log(`[LlmClient] Raw BATCH LLM Response (Session ${session.sessionId}):\n--- START RAW ---\n${rawText}\n--- END RAW ---`);

            // --- Parse Response --- 
            let commentaries = null;

            // 2. Parse the entire text as JSON
            let jsonText = rawText.trim(); // Use the whole raw text now
            try {
                // Be robust against potential leading/trailing whitespace or minor formatting issues
                const potentialJson = jsonText.substring(jsonText.indexOf('['), jsonText.lastIndexOf(']') + 1);
                commentaries = JSON.parse(potentialJson);
                if (!Array.isArray(commentaries) || commentaries.some(c => typeof c !== 'string')) {
                    console.error(`[LlmClient] Parsed JSON is not an array of strings for batch commentary (Session ${session.sessionId}).`);
                    commentaries = null; // Invalid format
                } else {
                    console.log(`[LlmClient] Successfully parsed ${commentaries.length} batch commentaries (Session ${session.sessionId}).`);
                }
            } catch (jsonError) {
                console.error(`[LlmClient] Failed to parse JSON from batch response (Session ${session.sessionId}):`, jsonError.message);
                console.error(`[LlmClient] Attempted to parse: ${jsonText}`);
                commentaries = null; // Failed to parse
            }
            // --- End Parse Response ---

            return { commentaries }; // Return only commentaries

        } catch (error) {
             // Handle potential Gemini API errors (like content blocking)
             let errorMessage = `Gemini API error during BATCH commentary generation for session ${session.sessionId}`;
             if (error.response && error.response.promptFeedback && error.response.promptFeedback.blockReason) {
                 errorMessage += `. Reason: ${error.response.promptFeedback.blockReason}`;
             }
             console.error(errorMessage, error.message);
            return { commentaries: null }; // Return null commentaries on error
        }
    }
    // --- END Batch Commentary Generation ---

    /**
     * Generates/updates a concise profile summary based on session activity.
     * @param {string} userId - The user ID (for logging).
     * @param {string[]} triggeredTags - Array of tags the user clicked 'TRIGGERED' on during the session.
     * @param {string} currentPersonalizationNotes - Notes entered by the user for this session.
     * @param {string} previousSummary - The previously stored LLM-generated summary.
     * @returns {Promise<string|null>} The new profile summary string, or null on error/no update needed.
     */
    static async generateUserProfileSummary(userId, triggeredTags, currentPersonalizationNotes, previousSummary) {
        const model = getNextMainModel(); // Or potentially use the flash model for this?
        if (!model) {
            console.error(`[LlmClient] Cannot generate profile summary for user ${userId}: No model available.`);
            return null;
        }

        const prompt = `
        **TASK:** Update or create a concise user profile summary based on their last session activity and notes.

        **Goal:** Create a short summary (3-4 bullet points max) highlighting observed preferences, kinks, and triggers. This summary will be shown to the user in their /info command. Keep it factual based on input, but use slightly suggestive language appropriate for the bot's theme.

        **Input Data:**
        *   **Previous Summary:** "${previousSummary || 'None'}"
        *   **User Notes for Last Session:** "${currentPersonalizationNotes || 'None'}"
        *   **Tags User Marked as 'TRIGGERED' in Last Session:** ${triggeredTags.length > 0 ? triggeredTags.join(', ') : 'None'}

        **Instructions:**
        1.  **Synthesize:** Combine information from all inputs. Prioritize newly triggered tags and recent user notes.
        2.  **Update/Create Summary:** If a previous summary exists, update it. If not, create one. 
        3.  **Format:** Use bullet points (e.g., "* Seems particularly responsive to [tag]\n* Requested to be called [nickname]").
        4.  **Conciseness:** Keep the summary brief (3-4 points total).
        5.  **Tone:** Factual but suggestive, reflecting the bot's nature.
        6.  **If No New Info:** If triggered tags are empty and notes are empty/unchanged from previous state implicitly reflected in summary, you can optionally return the exact previous summary or indicate no update needed by returning just "NO_UPDATE".

        **Example Output (New User):**
        *   Seems highly triggered by 'anal' and 'ahegao' tags.
        *   Requested being called 'good boy'.
        *   Appears to enjoy degradation elements.

        **Example Output (Update):**
        *   Continues to respond strongly to 'anal' and 'ahegao'.
        *   Triggered on 'mind break' this session.
        *   Still prefers being called 'good boy'.
        *   Mentioned interest in 'foot fetish' themes in notes.

        Generate the updated user profile summary now.
        `;

        try {
            console.log(`[LlmClient] Generating profile summary for user ${userId}. Triggers: [${triggeredTags.join(', ')}], Notes: "${currentPersonalizationNotes}", Prev Summary: "${previousSummary}"`);
            const result = await model.generateContent({ 
                contents: [{ role: "user", parts: [{ text: prompt }] }], 
                safetySettings, 
                // Maybe lower temperature for more factual summary?
                generationConfig: { temperature: 0.5 } 
            });
            const response = result.response;
            const newSummary = response.text()?.trim();

            if (!newSummary || newSummary === 'NO_UPDATE') {
                 console.log(`[LlmClient] No profile summary update needed for user ${userId}.`);
                 return null; // Indicate no update or keep previous
            }
            
            console.log(`[LlmClient] Generated new profile summary for user ${userId}:\n${newSummary}`);
            return newSummary;

        } catch (error) {
            console.error(`[LlmClient] Gemini API error during profile summary generation for user ${userId}:`, error);
            if (error.response && error.response.promptFeedback) {
                console.error('[LlmClient] Summary Generation Prompt Feedback:', error.response.promptFeedback);
            }
            return null; // Return null on error
        }
    }
}

module.exports = LlmClient; 