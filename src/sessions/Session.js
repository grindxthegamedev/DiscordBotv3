const crypto = require('crypto');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const pluginLoader = require('../plugins/pluginLoader');
const Rule34Client = require('../media/rule34Client');
const LlmClient = require('../llm/client'); // Eager load LLM Client
const MediaFetcher = require('../media/fetcher'); // Eager load Media Fetcher
const { getSubredditTopPosts, isSuitableRedditMediaPost, fetchRandomTopRedditImageUrl } = require('../media/redditClient'); // Import specific Reddit client functions
const UserData = require('../utils/userData'); // <<< Import UserData
const { shuffle } = require('../utils/random');
const axios = require('axios'); // <<< ADDED for fetching media
const fs = require('fs').promises; // <<< ADDED for potential file operations (async version)
const ffmpeg = require('fluent-ffmpeg');
const os = require('os');
const path = require('path');
const SessionManager = require('./SessionManager'); // Import SessionManager
// const ffmpeg = require('fluent-ffmpeg'); // <<< COMMENTED OUT - Add later if needed

// Define intervals/timeouts (in milliseconds)
const ACTION_INTERVAL_MS = 8 * 1000; // Time between bot actions (media + commentary)
const COMMENTARY_BATCH_SIZE = 3; // <<< NEW: Number of commentaries to generate per LLM call
// const ACTIVITY_CHECK_INTERVAL_MS = 10 * 60 * 1000; // Keep as fallback - currently disabled by removing start call
// const ACTIVITY_TIMEOUT_MS = 30 * 1000;
const LLM_TAG_SUGGESTION_THRESHOLD = 5; // Start suggesting tags after this many cycles

// Button Rows
const endSessionButton = new ButtonBuilder()
    .setCustomId('end_session_button')
    .setLabel('End Session')
    .setStyle(ButtonStyle.Danger);
const actionRowWithButton = new ActionRowBuilder().addComponents(endSessionButton);

// --- NEW: Trigger Button Definition ---
const triggeredButton = new ButtonBuilder()
    .setCustomId('triggered_button')
    .setLabel('TRIGGERED 😵‍💫')
    .setStyle(ButtonStyle.Success); // Green button to indicate positivity
const actionRowWithTriggerButton = new ActionRowBuilder().addComponents(triggeredButton);
// --- END Trigger Button Definition ---

// Activity check button (currently unused)
// const activityCheckButton = new ButtonBuilder()
//     .setCustomId('activity_check_button')
//     .setLabel('I\'m still here!')
//     .setStyle(ButtonStyle.Success);
// const actionRowWithActivityButton = new ActionRowBuilder().addComponents(activityCheckButton);

class Session {
    /**
     * @param {string} userId
     * @param {object} characterPlugin - The loaded character plugin object
     * @param {number} durationMinutes
     * @param {string} personalization - Optional personalization notes
     * @param {boolean} useProfileSummary - Whether to use saved profile for this session
     */
    constructor(userId, characterPlugin, durationMinutes, personalization, useProfileSummary) {
        this.sessionId = crypto.randomUUID();
        this.userId = userId;
        this.characterPlugin = characterPlugin; // Store the whole plugin
        this.characterType = characterPlugin.characterType || 'fictional'; // Default to fictional if missing
        this.durationMinutes = durationMinutes;
        this.personalization = personalization || ''; // <<< Store personalization
        this.useProfileSummary = useProfileSummary || false; // <<< Store profile usage choice
        this.startTime = Date.now();
        this.isActive = true;
        this.dmChannelId = null;
        this.actionLoopTimerId = null;
        // this.activityCheckIntervalId = null; // Disabled
        // this.activityCheckTimeoutId = null; // Disabled
        this.sessionEndTimerId = null;
        this.dynamicAvatarUrl = null;
        this.postedMediaUrls = new Set();
        this.postCycleCount = 0; // Counter for cycles
        this.currentMediaMessageId = null; // <<< ADDED: Stores ID of the message showing the media
        this.currentCommentaryMessageId = null; // <<< ADDED: Stores ID of the message with the commentary

        // --- NEW: Trigger Tracking --- 
        this.triggeredTags = new Set(); // Stores tags the user has 'triggered' on
        this.lastSentMediaInfo = null; // Stores the {url, post} of the last media sent
        // --- END Trigger Tracking --- 

        // --- NEW: Batch Processing Queues ---
        this.mediaBatchQueue = []; // Stores fetched media items for the current batch {url, post}
        this.commentaryQueue = []; // Stores generated commentary strings for the current batch
        // --- End Batch Processing Queues ---

        // --- NEW: Reddit Fetch State ---
        this.redditPostsPool = []; // Stores suitable post objects fetched from Reddit
        this.redditFetchState = {}; // Tracks pagination state per subreddit { subreddit: { after: string|null, isFetching: bool, allFetched: bool, currentPage: int } }
        // --- End Reddit Fetch State ---

        // Determine the source list based on character type
        if (this.characterType === 'real') {
            this.sourceList = this.characterPlugin.subreddits || [];
        } else { // Default to fictional / Rule34
            this.sourceList = this.characterPlugin.tags || [];
        }
         // Tags to use for the *next* Rule34 fetch (only relevant if characterType is fictional)
         // Initialize with the base list, LLM might refine it later
        this.currentRule34Tags = this.characterType === 'fictional' ? [...this.sourceList] : [];

        console.log(`[Session ${this.sessionId}] Created for user ${this.userId}, character ${this.characterPlugin.characterName} (${this.characterType}), duration ${durationMinutes}m`);
        if (this.sourceList.length === 0) {
            console.warn(`[Session ${this.sessionId}] Warning: Character source list (tags/subreddits) is empty!`);
        }
    }

    // --- NEW HELPER: Fetches next page for a subreddit, adds to pool, updates state ---
    /**
     * Fetches the next page of posts for a given subreddit and adds suitable media to the pool.
     * Handles updating the fetch state.
     * @param {string} subreddit The subreddit to fetch.
     * @param {boolean} [isBackground=true] If true, runs fetch without blocking, only updating state. If false, awaits fetch.
     * @returns {Promise<boolean>} True if new posts *might* have been added, false otherwise (error, already fetching, all fetched).
     */
    async fetchNextRedditPage(subreddit, isBackground = true) {
        if (!this.isActive || !subreddit || !this.redditFetchState[subreddit]) {
            console.warn(`[Session ${this.sessionId}] Invalid call to fetchNextRedditPage for subreddit: ${subreddit}`);
            return false;
        }

        const state = this.redditFetchState[subreddit];

        if (state.isFetching || state.allFetched) {
            return false;
        }

        state.isFetching = true;
        console.log(`[Session ${this.sessionId}] ${isBackground ? 'Background' : 'Synchronous'} fetch starting for r/${subreddit}, Page: ${state.currentPage}, After: ${state.after || 'Start'}`);

        const fetchPromise = getSubredditTopPosts(subreddit, 100, 'all', state.after)
            .then(result => {
                if (!this.isActive) return;

                if (result && result.posts && result.posts.length > 0) {
                    // Include direct media posts and gallery posts
                    const newItems = [];
                    result.posts.forEach(post => {
                        // Gallery posts: extract each image
                        if (post.is_gallery && post.gallery_data && post.media_metadata) {
                            post.gallery_data.items.forEach(item => {
                                const mediaMeta = post.media_metadata[item.media_id];
                                const url = mediaMeta?.s?.u?.replace(/&amp;/g, '&');
                                if (url) {
                                    newItems.push({ url, post });
                                }
                            });
                        } else if (isSuitableRedditMediaPost(post)) {
                            newItems.push({ url: post.url, post });
                        }
                    });
                    this.redditPostsPool.push(...newItems);
                    state.after = result.after;
                    state.currentPage++;
                    console.log(`[Session ${this.sessionId}] Fetched page ${state.currentPage - 1} for r/${subreddit}. Added ${newItems.length} suitable items (Pool size: ${this.redditPostsPool.length}). Next after: ${state.after}`);
                    if (!state.after) {
                        state.allFetched = true;
                        console.log(`[Session ${this.sessionId}] All pages fetched for r/${subreddit}.`);
                    }
                } else {
                    state.allFetched = true;
                    console.log(`[Session ${this.sessionId}] No more posts found or error fetching page ${state.currentPage} for r/${subreddit}. Marking as all fetched.`);
                }
            })
            .catch(error => {
                console.error(`[Session ${this.sessionId}] Error during Reddit fetch for r/${subreddit}:`, error);
                state.allFetched = true; // Assume error means we stop fetching this sub
            })
            .finally(() => {
                if (this.redditFetchState[subreddit]) { // Check if state still exists (session might have ended)
                    this.redditFetchState[subreddit].isFetching = false;
                    console.log(`[Session ${this.sessionId}] Fetch finished for r/${subreddit}. isFetching set to false.`);
                }
            });

        if (!isBackground) {
            console.log(`[Session ${this.sessionId}] Awaiting synchronous fetch for r/${subreddit}...`);
            await fetchPromise;
            console.log(`[Session ${this.sessionId}] Synchronous fetch complete for r/${subreddit}.`);
            return true; // Indicate fetch was attempted
        }
        
        // For background fetch, don't await, just return true indication
        return true;
    }
    // --- END NEW HELPER ---

    endSession(reason = 'Unknown') {
        if (!this.isActive) return; // Avoid running end logic multiple times

        // --- Store Final Session State (Premium) --- 
        // Use .then() to avoid delaying session end acknowledgement
        UserData.getUserPremiumStatus(this.userId).then(isPremium => {
            if (isPremium) {
                console.log(`[Session ${this.sessionId}] Premium user detected. Generating profile summary.`);
                // Fetch previous summary before calling LLM
                UserData.getLlmProfileSummary(this.userId).then(previousSummary => {
                    LlmClient.generateUserProfileSummary(
                        this.userId,
                        Array.from(this.triggeredTags), // Pass tags from this session
                        this.personalization, // Pass notes from this session
                        previousSummary // Pass the previously saved summary
                    ).then(newSummary => {
                        if (newSummary) {
                            UserData.setLlmProfileSummary(this.userId, newSummary)
                                .catch(err => console.error(`[Session ${this.sessionId}] Failed to save LLM profile summary:`, err));
                        }
                    }).catch(err => console.error(`[Session ${this.sessionId}] Failed to generate LLM profile summary:`, err));
                }).catch(err => console.error(`[Session ${this.sessionId}] Failed to fetch previous LLM profile summary:`, err));
            }
        }).catch(err => console.error(`[Session ${this.sessionId}] Failed to check premium status for summary generation:`, err));
        // --- End Profile Summary --- 

        // --- Calculate and Deduct Time --- 
        const elapsedMs = Date.now() - this.startTime;
        const elapsedMinutes = Math.ceil(elapsedMs / (60 * 1000)); // Round up partial minutes
        console.log(`[Session ${this.sessionId}] Session lasted ${elapsedMinutes} minutes (rounded up from ${elapsedMs}ms).`);
        // Use await here if updateUserTime becomes truly async later
        UserData.updateUserTime(this.userId, elapsedMinutes);
        // --- End Time Deduction ---

        // --- Standard Session Cleanup ---
        this.isActive = false;
        if (this.actionLoopTimerId) clearTimeout(this.actionLoopTimerId);
        // if (this.activityCheckIntervalId) clearInterval(this.activityCheckIntervalId); // Disabled
        // if (this.activityCheckTimeoutId) clearTimeout(this.activityCheckTimeoutId); // Disabled
        if (this.sessionEndTimerId) clearTimeout(this.sessionEndTimerId);

        console.log(`Session ${this.sessionId} for user ${this.userId} ended. Reason: ${reason}`);
         // Clean up potentially large sets/maps
        this.postedMediaUrls.clear();
        this.currentMediaMessageId = null; // Reset message ID on end
        this.currentCommentaryMessageId = null; // <<< ADDED: Reset commentary message ID on end
        this.redditPostsPool = []; // Clear reddit pool
        this.redditFetchState = {}; // Clear reddit state
        this.mediaBatchQueue = []; // Clear media batch queue
        this.commentaryQueue = []; // Clear commentary queue
        this.triggeredTags.clear(); // <<< ADDED: Clear triggers on session end
        this.lastSentMediaInfo = null; // <<< ADDED: Clear last sent media info

        // --- NEW: Remove from SessionManager (Redis + Local Map) ---
        // Pass the shard ID if available from the client instance (needs client access)
        // For now, we don't have direct access to `client` here, so SessionManager
        // might log 'unknown shard' when deleting locally, which is acceptable.
        SessionManager.deleteSession(this.userId);
        // --- END NEW ---
    }

    setDmChannelId(channelId) {
        this.dmChannelId = channelId;
        console.log(`DM channel ID ${channelId} stored for session ${this.sessionId}`);
    }

    // resetActivityTimeout() { // Disabled
    //     if (this.activityCheckTimeoutId) {
    //         clearTimeout(this.activityCheckTimeoutId);
    //         this.activityCheckTimeoutId = null;
    //         console.log(`[Session ${this.sessionId}] Activity confirmed by user.`);
    //     }
    // }

    /** Safely fetches the DM channel */
    async getDmChannel(client) {
         if (!this.dmChannelId) return null;
         try {
            return await client.channels.fetch(this.dmChannelId);
        } catch (err) {
            console.error(`[Session ${this.sessionId}] Failed to fetch DM channel ${this.dmChannelId}:`, err);
            this.endSession('DM Channel Fetch Failed');
            return null;
        }
    }

    /** Starts the main action loop timer */
    startActionLoopTimer(client) {
        if (!this.isActive) return;
        if (this.actionLoopTimerId) clearTimeout(this.actionLoopTimerId);

        this.actionLoopTimerId = setTimeout(async () => {
            if (!this.isActive) return;
            console.log(`[Session ${this.sessionId}] Action loop timer fired.`);
            await this.executeNextActionCycle(client); // Trigger next cycle
        }, ACTION_INTERVAL_MS);
    }

    /** Core logic for fetching media, generating commentary, and sending */
    async executeNextActionCycle(client) {
        if (!this.isActive) return;

        // --- Check Premium Status --- 
        const isPremium = await UserData.getUserPremiumStatus(this.userId);

        const dmChannel = await this.getDmChannel(client);
        if (!dmChannel || !this.isActive) return;

        // --- Mid-Session Time Check --- 
        const elapsedMs = Date.now() - this.startTime;
        const elapsedMinutes = Math.ceil(elapsedMs / (60 * 1000)); // Time already spent
        const remainingTime = await UserData.getUserTime(this.userId);
        
        if (elapsedMinutes >= remainingTime) {
            console.log(`[Session ${this.sessionId}] User ${this.userId} ran out of time mid-session (Elapsed: ${elapsedMinutes}min, Remaining: ${remainingTime}min). Ending session.`);
            // Send a quick message indicating why it ended
            try {
                 await dmChannel.send({ content: "Looks like your time is up! Session ended.", components: [] });
            } catch (e) { /* Ignore errors sending final message */ }
            
            this.endSession('Ran out of time'); // endSession will handle the final time deduction
            return; // Stop this cycle
        }
        // --- End Mid-Session Time Check ---

        // Clear pending timer before processing
        if (this.actionLoopTimerId) clearTimeout(this.actionLoopTimerId);

        const characterName = this.characterPlugin.characterName;
        let mediaToSend = null;
        let commentaryToSend = null;

        try {
            this.postCycleCount++;
             console.log(`[Session ${this.sessionId}] Starting action cycle ${this.postCycleCount} for ${characterName} (${this.characterType})`);

            // --- Check Queues First --- 
            if (this.commentaryQueue.length > 0 && this.mediaBatchQueue.length > 0) {
                 console.log(`[Session ${this.sessionId}] Using queued commentary and media.`);
                 mediaToSend = this.mediaBatchQueue.shift(); // Get next media item
                 commentaryToSend = this.commentaryQueue.shift(); // Get corresponding commentary
            } else {
                console.log(`[Session ${this.sessionId}] Queues empty. Fetching new media/commentary...`);
                // Queues are empty, need to fetch/generate
                this.mediaBatchQueue = []; // Clear just in case
                this.commentaryQueue = [];

                let fetchedItem = null; // Use a single item variable for non-batch path
                let llmResult = null; // To store LLM output
                const shouldLLMSuggestTags = this.postCycleCount >= LLM_TAG_SUGGESTION_THRESHOLD;

                if (this.characterType === 'real') {
                    // --- Handle Reddit SINGLE Item Selection ---
                    console.log(`[Session ${this.sessionId}] Selecting single Reddit post (Pool size: ${this.redditPostsPool.length})`);
                    let candidate = null;
                    let attempts = 0;
                    const maxAttempts = this.redditPostsPool.length + 5; // Limit attempts to avoid infinite loop

                    while (!candidate && attempts < maxAttempts && this.redditPostsPool.length > 0) {
                        attempts++;
                        const randomIndex = Math.floor(Math.random() * this.redditPostsPool.length);
                        const potentialPost = this.redditPostsPool[randomIndex];
                        const mappedPost = this._mapRedditPostToFetchedMedia(potentialPost);
                        if (mappedPost && !this.postedMediaUrls.has(mappedPost.url)) {
                            candidate = mappedPost;
                        }
                    }

                    // If pool was insufficient after random attempts, try synchronous fetch
                    if (!candidate) {
                        console.warn(`[Session ${this.sessionId}] Pool insufficient for selection. Attempting synchronous fetch...`);
                        const subredditsToFetch = Object.keys(this.redditFetchState).filter(sub => 
                            this.redditFetchState[sub] && !this.redditFetchState[sub].allFetched && !this.redditFetchState[sub].isFetching
                        );
                        if (subredditsToFetch.length > 0) {
                            const subToFetchSync = subredditsToFetch[0];
                            const fetchSuccess = await this.fetchNextRedditPage(subToFetchSync, false); // Synchronous fetch
                            if (fetchSuccess) {
                                console.log(`[Session ${this.sessionId}] Retrying selection from pool after sync fetch.`);
                                attempts = 0; // Reset attempts for retry
                                while (!candidate && attempts < maxAttempts && this.redditPostsPool.length > 0) {
                                     attempts++;
                                     const randomIndex = Math.floor(Math.random() * this.redditPostsPool.length);
                                     const potentialPost = this.redditPostsPool[randomIndex];
                                     const mappedPost = this._mapRedditPostToFetchedMedia(potentialPost);
                                     if (mappedPost && !this.postedMediaUrls.has(mappedPost.url)) {
                                         candidate = mappedPost;
                                     }
                                }
                            }
                        }
                    }
                    
                    if (candidate) {
                        fetchedItem = candidate;
                        console.log(`[Session ${this.sessionId}] Selected Reddit post: ${fetchedItem.url}`);

                        // --- NEW: Get Image Base64 ---
                        const imageBase64 = await this._getMediaAsBase64(fetchedItem.url);
                        if (!imageBase64) {
                             console.log(`[Session ${this.sessionId}] Could not get image Base64. Commentary will lack visual context.`);
                        }
                        // --- END: Get Image Base64 ---

                        // --- Generate SINGLE Commentary (Now with integrated vision) ---
                         console.log(`[Session ${this.sessionId}] Calling generateMediaCommentary (with image).`);
                        const mediaTags = Array.isArray(fetchedItem.post.tags) ? fetchedItem.post.tags : (typeof fetchedItem.post.tags === 'string' ? fetchedItem.post.tags.split(' ').filter(Boolean) : []);
                        // Pass imageBase64 directly to the commentary function
                        llmResult = await LlmClient.generateMediaCommentary(
                            this,
                            mediaTags,
                            fetchedItem.post.title,
                            fetchedItem.post.flair,
                            imageBase64 // <<< Pass Base64 image data
                        );
                        // Note: Tag suggestion for Reddit type is not currently used, but we pass the flag.

                    } else {
                        console.warn(`[Session ${this.sessionId}] Failed to select any suitable Reddit post after fetches.`);
                    }

                    // Trigger background fetch for *next* cycle if possible (same logic as batch)
                    const subredditsToFetchAsync = Object.keys(this.redditFetchState).filter(sub => 
                        this.redditFetchState[sub] && !this.redditFetchState[sub].allFetched && !this.redditFetchState[sub].isFetching
                    );
                    if (subredditsToFetchAsync.length > 0) {
                        const subToFetchAsync = subredditsToFetchAsync[0]; 
                        console.log(`[Session ${this.sessionId}] Triggering background fetch for r/${subToFetchAsync}`);
                        this.fetchNextRedditPage(subToFetchAsync, true); // Fire and forget
                    }
                    // --- End Reddit SINGLE Item Handling ---

                } else if (this.characterType === 'fictional') {
                    // --- Handle Rule34 BATCH Selection and Commentary (as before) --- 
                    const listToFetchWith = this.currentRule34Tags.length > 0 ? this.currentRule34Tags : this.sourceList;
                     console.log(`[Session ${this.sessionId}] Calling MediaFetcher (Rule34) for BATCH with tags: ${listToFetchWith.join('+')}`);
                    let fetchedMediaBatch = await MediaFetcher.fetchMediaBatch( // Fetch a batch
                        this.characterType, 
                        listToFetchWith, 
                        this.postedMediaUrls,
                        this.sessionId,
                        COMMENTARY_BATCH_SIZE
                    );
                    if (!fetchedMediaBatch) fetchedMediaBatch = [];

                    if (fetchedMediaBatch.length > 0) {
                        // --- Analyze FIRST Image of Batch (Optional Enhancement - YAGNI for now) ---
                        // let firstImageAttributes = [];
                        // const firstImageBase64 = await this._getMediaAsBase64(fetchedMediaBatch[0].url);
                        // if (firstImageBase64) {
                        //     firstImageAttributes = await LlmClient.generateImageAttributes(firstImageBase64);
                        // }
                        // --- End Analyze First Image ---

                        this.mediaBatchQueue = fetchedMediaBatch; // Store the fetched batch

                        // Prepare context for LLM (WITHOUT image attributes for now)
                        const mediaBatchInfo = this.mediaBatchQueue.map(item => ({
                            tags: Array.isArray(item.post.tags) ? item.post.tags : (typeof item.post.tags === 'string' ? item.post.tags.split(' ').filter(Boolean) : []),
                            title: item.post.title || null,
                            flair: item.post.flair || null,
                            imageAttributes: [] // <<< Send empty array for now
                            // imageAttributes: index === 0 ? firstImageAttributes : [] // Example: Only pass for first item
                        }));
                        
                         console.log(`[Session ${this.sessionId}] Calling generateBatchCommentary for ${this.mediaBatchQueue.length} items.`);
                        const batchLlmResult = await LlmClient.generateBatchCommentary(this, mediaBatchInfo);

                        if (batchLlmResult && batchLlmResult.commentaries && batchLlmResult.commentaries.length === this.mediaBatchQueue.length) {
                            this.commentaryQueue = batchLlmResult.commentaries; // Store generated commentaries
                             console.log(`[Session ${this.sessionId}] Successfully generated ${this.commentaryQueue.length} batch commentaries.`);
                        } else {
                             console.error(`[Session ${this.sessionId}] Failed to generate batch commentary or mismatch in count. LLM Result:`, batchLlmResult);
                             this.mediaBatchQueue = []; 
                             this.commentaryQueue = [];
                        }
                    } else {
                         console.warn(`[Session ${this.sessionId}] Could not fetch any media for the Rule34 batch.`);
                    }
                    // --- End Rule34 BATCH Handling ---
                }

                // --- Dequeue Item for Sending --- 
                if (fetchedItem && llmResult && llmResult.commentary) {
                    // Single item path (Reddit)
                    mediaToSend = fetchedItem;
                    commentaryToSend = llmResult.commentary;
                     console.log(`[Session ${this.sessionId}] Using fetched single item.`);
                } else if (this.commentaryQueue.length > 0 && this.mediaBatchQueue.length > 0) {
                    // Batch item path (Rule34)
                    mediaToSend = this.mediaBatchQueue.shift();
                    commentaryToSend = this.commentaryQueue.shift();
                     console.log(`[Session ${this.sessionId}] Dequeuing first item from batch.`);
                } else {
                    console.warn(`[Session ${this.sessionId}] No item fetched or commentary generated.`);
                }
            } // End of initial queue check (else block)

            // --- Step 3: Process and Send the Dequeued Item (if any) --- 
            if (!mediaToSend || !commentaryToSend) {
                 console.warn(`[Session ${this.sessionId}] No commentary/media available to send for cycle ${this.postCycleCount}. Skipping.`);
                 if (this.isActive) this.startActionLoopTimer(client); // Restart timer
                 return;
            }

            // --- Step 3.5: Store Media Info for Trigger Tracking --- 
            // Store this *before* sending/editing, so it's available if the user clicks the button
            this.lastSentMediaInfo = mediaToSend;
            // --- End Step 3.5 ---

            // --- Step 4: Send Commentary --- 
            if (commentaryToSend && this.isActive) {
                const newEmbed = new EmbedBuilder()
                    .setAuthor({ name: characterName, iconURL: this.dynamicAvatarUrl || this.characterPlugin.fallbackAvatarUrl || undefined })
                    .setDescription(commentaryToSend) // Use the dequeued commentary
                    .setColor(0xAA00AA);
                
                if (this.currentCommentaryMessageId) {
                    // --- Edit existing commentary message ---
                    try {
                        const existingCommentaryMsg = await dmChannel.messages.fetch(this.currentCommentaryMessageId);
                        if (existingCommentaryMsg) {
                            console.log(`[Session ${this.sessionId}] Editing commentary message ${this.currentCommentaryMessageId}`);
                            await existingCommentaryMsg.edit({ embeds: [newEmbed], components: [actionRowWithButton] });
                        } else {
                            console.warn(`[Session ${this.sessionId}] Failed to fetch commentary message ${this.currentCommentaryMessageId} for editing (not found).`);
                            this.currentCommentaryMessageId = null; // Reset ID
                        }
                    } catch (error) {
                        console.error(`[Session ${this.sessionId}] Error fetching/editing commentary message ${this.currentCommentaryMessageId}:`, error.message);
                        this.currentCommentaryMessageId = null; // Reset ID on error
                    }
                } 
                
                // --- Send new commentary message if needed (first time or edit failed) ---
                if (!this.currentCommentaryMessageId && this.isActive) {
                    console.log(`[Session ${this.sessionId}] Sending new commentary message.`);
                    try {
                        const sentCommentaryMsg = await dmChannel.send({ embeds: [newEmbed], components: [actionRowWithButton] });
                        this.currentCommentaryMessageId = sentCommentaryMsg.id;
                    } catch (sendError) {
                        console.error(`[Session ${this.sessionId}] Error sending new commentary message:`, sendError);
                        // If sending fails, maybe end session? For now, just log.
                    }
                }
            }

            // --- Step 5: Send/Edit Media --- 
            let mediaSentOrEdited = false;
            if (mediaToSend.url && this.isActive) {
                // <<< Define components based on premium status >>>
                const mediaComponents = isPremium ? [actionRowWithTriggerButton] : [];

                if (this.currentMediaMessageId) { // Check if there's an existing MEDIA message ID
                    // --- Edit existing message --- 
                    try {
                        const existingMessage = await dmChannel.messages.fetch(this.currentMediaMessageId);
                        if (existingMessage) {
                             console.log(`[Session ${this.sessionId}] Editing media message ${this.currentMediaMessageId} with URL: ${mediaToSend.url}`);
                            // Edit message content AND add/update the trigger button (or remove if not premium)
                            await existingMessage.edit({ 
                                content: mediaToSend.url, 
                                components: mediaComponents // <<< Use conditional components
                            }); 
                            mediaSentOrEdited = true;
                        } else {
                            console.warn(`[Session ${this.sessionId}] Failed to fetch media message ${this.currentMediaMessageId} for editing (not found).`);
                             this.currentMediaMessageId = null; // Reset ID
                        }
                    } catch (error) {
                        console.error(`[Session ${this.sessionId}] Error fetching/editing media message ${this.currentMediaMessageId}:`, error.message);
                        this.currentMediaMessageId = null; // Reset ID
                    }
                }

                // --- Send new message if needed (first time or edit failed) --- 
                if (!this.currentMediaMessageId && this.isActive) { // Use MEDIA message ID check
                     console.log(`[Session ${this.sessionId}] Sending new media message with URL: ${mediaToSend.url}`);
                    try {
                        // Send message content AND the trigger button (or empty if not premium)
                        const sentMessage = await dmChannel.send({ 
                            content: mediaToSend.url, 
                            components: mediaComponents // <<< Use conditional components
                        }); 
                        this.currentMediaMessageId = sentMessage.id;
                         mediaSentOrEdited = true;
                    } catch (sendError) {
                         console.error(`[Session ${this.sessionId}] Error sending new media message:`, sendError);
                    }
                }

                if (mediaSentOrEdited) {
                    this.postedMediaUrls.add(mediaToSend.url); // Add the SENT media URL
                }
            }
            // --- End Step 5 --- 

            // --- Step 6: Restart Action Loop Timer --- 
            if (this.isActive) {
                this.startActionLoopTimer(client);
            }

        } catch (err) {
            console.error(`[Session ${this.sessionId}] Error during executeNextActionCycle:`, err);
            if (this.isActive) {
                // Maybe add a delay before restarting timer after an error?
                setTimeout(() => this.startActionLoopTimer(client), ACTION_INTERVAL_MS / 2);
            }
        }
    }

    // --- NEW: Helper to map Reddit post data ---
    /**
     * Maps a raw Reddit pool item to the standard fetchedMedia format.
     * Handles individual gallery images or single posts.
     * @param {object} item The raw pool item, either {url, post} for gallery or for normal posts.
     * @returns {{url: string, post: object} | null}
     */
    _mapRedditPostToFetchedMedia(item) {
        // Handle gallery or direct items mapped as {url, post}
        if (item && item.url && item.post && typeof item.post === 'object') {
            const raw = item.post;
            // Only include the subreddit in the tags passed to the LLM
            const tags = [raw.subreddit].filter(Boolean);
            return {
                url: item.url,
                post: {
                    id: raw.id,
                    title: raw.title || null,
                    flair: raw.link_flair_text || null,
                    score: raw.score || 0,
                    tags: tags, // Now only contains subreddit
                    source: `https://www.reddit.com${raw.permalink}`,
                    file_url: item.url,
                    preview_url: raw.thumbnail && raw.thumbnail !== 'default' && raw.thumbnail !== 'self'
                                  ? raw.thumbnail
                                  : item.url,
                }
            };
        }
        return null; // Unsupported item
    }
    // --- END Reddit Map Helper ---

    // --- NEW: Method to record triggered tags --- 
    recordTrigger() {
        if (!this.lastSentMediaInfo || !this.lastSentMediaInfo.post || !Array.isArray(this.lastSentMediaInfo.post.tags)) {
            console.warn(`[Session ${this.sessionId}] Cannot record trigger: lastSentMediaInfo or its tags are missing/invalid.`);
            return;
        }

        const tagsToRecord = this.lastSentMediaInfo.post.tags;
        if (tagsToRecord.length > 0) {
            tagsToRecord.forEach(tag => this.triggeredTags.add(tag));
            console.log(`[Session ${this.sessionId}] Recorded trigger tags: ${tagsToRecord.join(', ')}. Current triggers: ${Array.from(this.triggeredTags).join(', ')}`);
        } else {
             console.log(`[Session ${this.sessionId}] Trigger button clicked, but last media had no associated tags.`);
        }
    }
    // --- END Trigger Recording Method ---

    // --- NEW: Helper to fetch media and convert to Base64 ---
    /**
     * Fetches media from a URL and returns it as a Base64 string.
     * Currently only handles images directly.
     * TODO: Add video/GIF frame extraction using fluent-ffmpeg.
     * @param {string} mediaUrl The URL of the media to fetch.
     * @returns {Promise<string|null>} Base64 encoded string or null on error.
     */
    async _getMediaAsBase64(mediaUrl) {
        if (!mediaUrl) return null;
        console.log(`[Session ${this.sessionId}] Attempting to fetch media for analysis: ${mediaUrl}`);
        try {
            const response = await axios.get(mediaUrl, {
                responseType: 'arraybuffer' // Fetch as raw bytes
            });

            const contentType = response.headers['content-type'];
            console.log(`[Session ${this.sessionId}] Media content type: ${contentType}`);

            const buffer = Buffer.from(response.data, 'binary');
            // Static images
            if (contentType && (contentType.startsWith('image/jpeg') || contentType.startsWith('image/png') || contentType.startsWith('image/webp'))) {
                const base64 = buffer.toString('base64');
                console.log(`[Session ${this.sessionId}] Successfully fetched and converted image to Base64.`);
                return base64;
            }
            // GIF or video: extract a random frame
            if (contentType && (contentType.startsWith('image/gif') || contentType.startsWith('video/'))) {
                console.log(`[Session ${this.sessionId}] Detected ${contentType}, extracting random frame.`);
                // Write buffer to temp input file
                const ext = contentType.startsWith('image/gif') ? '.gif' : path.extname(mediaUrl).split('?')[0] || '.mp4';
                const tmpInput = path.join(os.tmpdir(), `${crypto.randomUUID()}${ext}`);
                const tmpFrame = path.join(os.tmpdir(), `${crypto.randomUUID()}.jpg`);
                console.log(`[Session ${this.sessionId}] Writing media to temp file: ${tmpInput}`);
                await fs.writeFile(tmpInput, buffer);
                // Probe for duration
                let duration = 1;
                try {
                    duration = await new Promise((res, rej) => {
                        ffmpeg.ffprobe(tmpInput, (err, meta) => {
                            if (err) return rej(err);
                            res(meta.format.duration || 1);
                        });
                    });
                } catch (probeErr) {
                    console.error(`[Session ${this.sessionId}] FFprobe error:`, probeErr.message);
                }
                const timestamp = (Math.random() * duration).toFixed(2);
                console.log(`[Session ${this.sessionId}] Extracting frame at ${timestamp}s to ${tmpFrame}`);
                await new Promise((res) => {
                    ffmpeg(tmpInput)
                        .screenshots({ timestamps: [timestamp], filename: path.basename(tmpFrame), folder: path.dirname(tmpFrame), size: '800x?' })
                        .on('end', res)
                        .on('error', (err) => {
                            console.error(`[Session ${this.sessionId}] FFmpeg error extracting frame:`, err.message);
                            res();
                        });
                });
                let frameBuffer = null;
                try {
                    frameBuffer = await fs.readFile(tmpFrame);
                } catch (readErr) {
                    console.error(`[Session ${this.sessionId}] Error reading frame file:`, readErr.message);
                }
                // Clean up temp files
                fs.unlink(tmpInput).catch(() => {});
                fs.unlink(tmpFrame).catch(() => {});
                if (!frameBuffer) return null;
                const base64 = frameBuffer.toString('base64');
                console.log(`[Session ${this.sessionId}] Frame extracted and converted to Base64.`);
                return base64;
            }
            console.warn(`[Session ${this.sessionId}] Unhandled content type (${contentType}), skipping analysis.`);
            return null;
        } catch (error) {
            console.error(`[Session ${this.sessionId}] Error fetching or converting media (${mediaUrl}):`, error.message);
            return null;
        }
    }
    // --- END Base64 Helper ---

    /** Starts the main session setup and timers */
    async startTimers(client) {
        if (!this.isActive || !this.dmChannelId) {
            console.error(`Cannot start session setup for inactive/invalid session ${this.sessionId}`);
            return;
        }

        const characterName = this.characterPlugin.characterName;
        const avatarTags = this.characterPlugin.avatarTags || [];
        const fallbackAvatar = this.characterPlugin.fallbackAvatarUrl;

        console.log(`Starting session setup for ${this.sessionId} (${characterName})`);

        // --- Fetch Dynamic Avatar --- 
        this.dynamicAvatarUrl = fallbackAvatar; // Start with fallback
        let avatarUrl = null;
        try {
            if (this.characterType === 'real' && this.sourceList.length > 0) {
                // --- Real Character: Use Reddit Top Image ---
                console.log(`[Session ${this.sessionId}] Attempting to fetch random top Reddit avatar from subs: ${this.sourceList.join(', ')}`);
                avatarUrl = await fetchRandomTopRedditImageUrl(this.sourceList);
                if (avatarUrl) {
                    console.log(`[Session ${this.sessionId}] Fetched random Reddit avatar for ${characterName}`);
                } else {
                    console.warn(`[Session ${this.sessionId}] Could not fetch random Reddit avatar for ${characterName}. Using fallback.`);
                }
            } else if (this.characterType === 'fictional' && avatarTags.length > 0) {
                // --- Fictional Character: Use Rule34Client --- 
                console.log(`[Session ${this.sessionId}] Attempting to fetch dynamic Rule34 avatar using tags: ${avatarTags.join('+')}`);
                avatarUrl = await Rule34Client.fetchTopPostImageUrl(avatarTags);
                if (avatarUrl) {
                    console.log(`[Session ${this.sessionId}] Fetched dynamic Rule34 avatar for ${characterName}`);
                } else {
                    console.warn(`[Session ${this.sessionId}] Could not fetch dynamic Rule34 avatar for ${characterName}. Using fallback.`);
                }
            } else {
                 console.warn(`[Session ${this.sessionId}] Cannot fetch dynamic avatar - Character type (${this.characterType}) unsupported or missing sources (subs: ${this.sourceList.length}, tags: ${avatarTags.length}). Using fallback.`);
            }
            
            // Assign the fetched URL if successful
            if (avatarUrl) {
                this.dynamicAvatarUrl = avatarUrl;
            }

        } catch (avatarError) {
             console.error(`[Session ${this.sessionId}] Error fetching dynamic avatar for ${characterName} (Type: ${this.characterType}):`, avatarError);
             // dynamicAvatarUrl already set to fallback
        }
        // ------------------------->
        
        // --- Initialize Reddit Fetch State & Fetch First Page (if applicable) ---
        let initialRedditFetchSub = null;
        if (this.characterType === 'real' && this.sourceList.length > 0) {
            this.sourceList.forEach(sub => {
                this.redditFetchState[sub] = { after: null, isFetching: false, allFetched: false, currentPage: 0 };
            });
            initialRedditFetchSub = this.sourceList[0]; // Just pick the first one for the initial fetch
            console.log(`[Session ${this.sessionId}] Initializing Reddit state for subs: ${this.sourceList.join(', ')}. Will fetch first page of r/${initialRedditFetchSub} synchronously.`);
            await this.fetchNextRedditPage(initialRedditFetchSub, false); // Fetch first page synchronously
            
            // Optional: Immediately trigger background fetch for the *second* page if desired?
            // Or let the action loop handle triggering subsequent fetches.
            // Let's let the action loop handle it for now.
        }
        // -------------------------------------------------------------------->

        // Send the initial opening message
        const dmChannel = await this.getDmChannel(client);
        if (!dmChannel || !this.isActive) return; // Ensure channel is valid before proceeding
        try {
            // TODO: Maybe use LLM for opening message later?
            // const openingMessage = await LlmClient.generateOpeningMessage(this); // Optional LLM opener
            const openingMessage = "Let's begin..."; // Hardcoded opener
            
            const embed = new EmbedBuilder()
                 .setAuthor({ name: characterName, iconURL: this.dynamicAvatarUrl || undefined }) // Use fetched or fallback
                 .setDescription(openingMessage)
                 .setColor(0xAA00AA);
            const initialCommentaryMessage = await dmChannel.send({ embeds: [embed], components: [actionRowWithButton] });
            this.currentCommentaryMessageId = initialCommentaryMessage.id; // <<< STORED ID
            console.log(`[Session ${this.sessionId}] Stored initial commentary message ID: ${this.currentCommentaryMessageId}`);

            // Start the first action loop cycle immediately after opening message
            if (this.isActive) {
                // Use a minimal delay just to space out the first action from the opener
                console.log(`[Session ${this.sessionId}] Scheduling first action cycle.`);
                setTimeout(() => this.executeNextActionCycle(client), 1000); 
            }
        } catch (initialError) {
            console.error(`[Session ${this.sessionId}] Error sending opening message:`, initialError);
            this.endSession('Opening Message Failed');
            return; 
        }
        
        // --- Session End Timer ---
        // Only set the timer if durationMinutes is a positive number
        if (this.durationMinutes && this.durationMinutes > 0) {
            const sessionDurationMs = this.durationMinutes * 60 * 1000;
            this.sessionEndTimerId = setTimeout(async () => { 
                if (!this.isActive) return;
                console.log(`Session ${this.sessionId} duration ended.`);
                const endDmChannel = await this.getDmChannel(client); // Re-fetch channel just in case
                if (endDmChannel) {
                    try {
                        const closingEmbed = new EmbedBuilder()
                            .setAuthor({ name: characterName, iconURL: this.dynamicAvatarUrl || fallbackAvatar || undefined })
                            .setDescription("Time's up! Hope you had fun.") // TODO: LLM closing message?
                            .setColor(0xAA00AA);
                        await endDmChannel.send({ embeds: [closingEmbed] });
                    } catch (closingError) {
                         console.error(`[Session ${this.sessionId}] Error sending closing message:`, closingError);
                    }
                }
                this.endSession('Duration Reached');
            }, sessionDurationMs);
            console.log(`[Session ${this.sessionId}] Session end timer set for ${this.durationMinutes} minutes.`);
        } else {
            console.log(`[Session ${this.sessionId}] No duration set, session will not end automatically.`);
        }

        // --- Activity Check Timer --- (Currently disabled)
        // this.startActivityCheckTimer(client);
    }

    // --- Activity Check Logic --- (Currently disabled)
    // startActivityCheckTimer(client) {
    //     if (!this.isActive) return;
    //     if (this.activityCheckIntervalId) clearInterval(this.activityCheckIntervalId);

    //     this.activityCheckIntervalId = setInterval(async () => {
    //         if (!this.isActive) return;
    //         console.log(`[Session ${this.sessionId}] Initiating activity check.`);
    //         const dmChannel = await this.getDmChannel(client);
    //         if (!dmChannel || !this.isActive) return;

    //         try {
    //              await dmChannel.send({
    //                  content: "Just checking if you're still with me, love!",
    //                  components: [actionRowWithActivityButton]
    //              });

    //             // Set a timeout for the user to respond
    //             if (this.activityCheckTimeoutId) clearTimeout(this.activityCheckTimeoutId);
    //             this.activityCheckTimeoutId = setTimeout(() => {
    //                 if (!this.isActive) return;
    //                  console.log(`[Session ${this.sessionId}] Activity check timed out.`);
    //                  this.endSession('Inactivity Timeout');
    //                  const SessionManager = require('./SessionManager');
    //                  SessionManager.deleteSession(this.userId);
    //             }, ACTIVITY_TIMEOUT_MS);

    //         } catch (err) {
    //              console.error(`[Session ${this.sessionId}] Error sending activity check:`, err);
    //         }
    //     }, ACTIVITY_CHECK_INTERVAL_MS);
    //     console.log(`[Session ${this.sessionId}] Activity check timer started.`);
    // }
}

module.exports = {
    Session, // Export the class
    triggeredButton, // <<< Export the button definition
    actionRowWithTriggerButton // <<< Export the action row
}; 