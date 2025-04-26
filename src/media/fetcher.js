const rule34Client = require('./rule34Client'); // Use rule34 client
const redditClient = require('./redditClient'); // Added Reddit client
const pluginLoader = require('../plugins/pluginLoader');
const { sample } = require('../utils/random'); // Assuming sample exists

/** 
 * Checks if a URL points to a direct image or video file.
 * (Rule34 file_url should typically be direct links)
 */
function isDirectMediaUrl(url) {
    if (!url) return false;
    // Basic check for common image/video extensions
    // Rule34 API posts often have 'sample_url' (lower res) and 'file_url' (full res)
    // We will prefer file_url
    return url.match(/\.(jpeg|jpg|gif|png|webp|mp4|webm)$/i) != null;
}

class MediaFetcher {
    /**
     * Fetches a random suitable media post object for the session's character.
     * Uses Rule34 for 'fictional' characters and Reddit for 'real' characters.
     * Filters out already posted media.
     *
     * @param {string} characterType - 'fictional' or 'real'.
     * @param {string[]} sourceList - Array of Rule34 tags (if fictional) or subreddits (if real).
     * @param {Set<string>} postedMediaUrls - A Set containing URLs that have already been posted in the session.
     * @param {string} sessionId - For logging purposes.
     * @param {number} [maxAttempts=5] - Maximum number of attempts to find unique media.
     * @returns {Promise<{url: string, post: object} | null>} An object containing the media URL and the full post object, or null.
     */
    static async fetchMedia(characterType, sourceList, postedMediaUrls, sessionId, maxAttempts = 5) {
        if (!sourceList || sourceList.length === 0) {
            console.warn(`[MediaFetcher] Session ${sessionId}: No tags/subreddits provided for fetchMedia.`);
            return null;
        }

        if (characterType === 'fictional') {
            return this._fetchRule34Media(sourceList, postedMediaUrls, sessionId, maxAttempts);
        } else if (characterType === 'real') {
            console.log(`[MediaFetcher] Session ${sessionId}: Skipping fetcher for 'real' type; Session handles Reddit pool.`);
            return null; // Signal to Session to use its internal pool
        } else {
            console.error(`[MediaFetcher] Session ${sessionId}: Unknown characterType: ${characterType}`);
            return null;
        }
    }

    /**
     * Internal helper to fetch from Rule34, handles pagination and uniqueness.
     */
    static async _fetchRule34Media(tags, postedMediaUrls, sessionId, maxAttempts) {
        const tagString = tags.join('+');
        const MAX_FETCH_PAGE = 10; // Limit pages to fetch from
        let attemptedPages = new Set();

        // Lower internal attempts since fetchMedia itself might be retried
        const rule34Attempts = Math.max(1, Math.floor(maxAttempts / 2)); 

        for (let attempt = 1; attempt <= rule34Attempts; attempt++) {
            let randomPageId = -1;
            if (attemptedPages.size >= MAX_FETCH_PAGE + 1) {
                console.warn(`[MediaFetcher] Session ${sessionId} (Rule34): Exhausted all pages (0-${MAX_FETCH_PAGE}).`);
                break; 
            }
            do {
                randomPageId = Math.floor(Math.random() * (MAX_FETCH_PAGE + 1));
            } while (attemptedPages.has(randomPageId));
            attemptedPages.add(randomPageId);

            console.log(`[MediaFetcher] Session ${sessionId} (Rule34): Attempt ${attempt}/${rule34Attempts}, fetching page ${randomPageId} for tags: ${tagString}`);
            const posts = await rule34Client.searchPosts(tags, 100, randomPageId);

            if (posts === null) {
                console.error(`[MediaFetcher] Session ${sessionId} (Rule34): API error on page ${randomPageId}.`);
                continue;
            }
            if (posts.length === 0) {
                console.log(`[MediaFetcher] Session ${sessionId} (Rule34): No posts found on page ${randomPageId}.`);
                continue;
            }

            const suitablePosts = posts.filter(post => {
                const postScore = parseInt(post.score, 10);
                // Consider using preview_url as fallback? Maybe not for main media.
                return post.file_url
                       && isDirectMediaUrl(post.file_url)
                       && !isNaN(postScore)
                       && postScore > 300; // Keep score filter for Rule34?
            });

            const uniquePosts = suitablePosts.filter(post => !postedMediaUrls.has(post.file_url));

            if (uniquePosts.length > 0) {
                const randomPost = sample(uniquePosts);
                 console.log(`[MediaFetcher] Session ${sessionId} (Rule34): Selected unique post ID ${randomPost.id} (Score: ${randomPost.score}) on attempt ${attempt} (page ${randomPageId})`);
                return { url: randomPost.file_url, post: randomPost };
            } else {
                 console.log(`[MediaFetcher] Session ${sessionId} (Rule34): No *unique* suitable posts found on page ${randomPageId}.`);
            }
        }

        console.warn(`[MediaFetcher] Session ${sessionId} (Rule34): Failed to find unique suitable media for tags "${tagString}" after ${rule34Attempts} page attempts.`);
        return null;
    }

    // --- NEW: Fetch Media Batch for Rule34 ---
    /**
     * Fetches a BATCH of random suitable media post objects for Rule34.
     * Attempts to fill a batch of a specified size.
     *
     * @param {string[]} tags - Array of Rule34 tags.
     * @param {Set<string>} postedMediaUrls - A Set containing URLs that have already been posted in the session.
     * @param {string} sessionId - For logging purposes.
     * @param {number} batchSize - The desired number of media items in the batch.
     * @param {number} [maxPageAttempts=5] - Max random pages to check.
     * @returns {Promise<Array<{url: string, post: object}>>} An array of media objects (can be smaller than batchSize).
     */
    static async fetchMediaBatch(characterType, tags, postedMediaUrls, sessionId, batchSize, maxPageAttempts = 5) {
         if (characterType !== 'fictional') {
             console.error(`[MediaFetcher] fetchMediaBatch called with invalid characterType: ${characterType}`);
             return []; // Only support fictional (Rule34) for now
         }
        
        const tagString = tags.join('+');
        const MAX_FETCH_PAGE = 10; // Limit pages to fetch from
        let attemptedPages = new Set();
        let foundMediaBatch = [];
        let currentAttempts = 0;

        console.log(`[MediaFetcher] Session ${sessionId} (Rule34 Batch): Starting fetch for batch size ${batchSize}, tags: ${tagString}`);

        // Keep trying pages until batch is full OR we run out of pages/attempts
        while (foundMediaBatch.length < batchSize && currentAttempts < maxPageAttempts && attemptedPages.size <= MAX_FETCH_PAGE + 1) {
            currentAttempts++;
            let randomPageId = -1;
            if (attemptedPages.size >= MAX_FETCH_PAGE + 1) {
                 console.warn(`[MediaFetcher] Session ${sessionId} (Rule34 Batch): Exhausted all pages (0-${MAX_FETCH_PAGE}).`);
                 break; // Stop if all pages checked
            }
            do {
                randomPageId = Math.floor(Math.random() * (MAX_FETCH_PAGE + 1));
            } while (attemptedPages.has(randomPageId));
            attemptedPages.add(randomPageId);

            console.log(`[MediaFetcher] Session ${sessionId} (Rule34 Batch): Attempt ${currentAttempts}/${maxPageAttempts}, trying page ${randomPageId}...`);
            const posts = await rule34Client.searchPosts(tags, 100, randomPageId);

            if (posts === null || posts.length === 0) {
                console.log(`[MediaFetcher] Session ${sessionId} (Rule34 Batch): No posts or API error on page ${randomPageId}.`);
                continue; // Try next page
            }

            const suitablePosts = posts.filter(post => {
                const postScore = parseInt(post.score, 10);
                return post.file_url && isDirectMediaUrl(post.file_url) && !isNaN(postScore) && postScore > 100; // Lower score threshold slightly for batch?
            });

            // Iterate through suitable posts on this page and add unique ones to the batch
            for (const post of suitablePosts) {
                if (foundMediaBatch.length >= batchSize) break; // Stop if batch is full

                const mediaUrl = post.file_url;
                // Check against already posted AND items already added to this specific batch
                if (!postedMediaUrls.has(mediaUrl) && !foundMediaBatch.some(item => item.url === mediaUrl)) {
                    console.log(`[MediaFetcher] Session ${sessionId} (Rule34 Batch): Adding unique post ID ${post.id} (Score: ${post.score}) from page ${randomPageId}. Batch size: ${foundMediaBatch.length + 1}/${batchSize}`);
                    foundMediaBatch.push({ url: mediaUrl, post: post });
                }
            }
        } // End while loop

        console.log(`[MediaFetcher] Session ${sessionId} (Rule34 Batch): Fetch finished. Found ${foundMediaBatch.length} unique media items for batch.`);
        return foundMediaBatch;
    }
    // --- END Fetch Media Batch ---
}

module.exports = MediaFetcher; 