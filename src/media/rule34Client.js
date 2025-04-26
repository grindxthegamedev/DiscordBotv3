const axios = require('axios');

const API_BASE_URL = 'https://api.rule34.xxx/index.php';

/**
 * Fetches posts from the rule34.xxx API based on tags.
 * @param {string[]} tags - An array of tags to search for. Tags will be joined by '+'.
 * @param {number} [limit=50] - The maximum number of posts to retrieve (max 1000).
 * @param {number} [pid=0] - The page number to retrieve.
 * @returns {Promise<Array<object> | null>} A promise that resolves to an array of post objects or null if an error occurs.
 */
async function searchPosts(tags, limit = 50, pid = 0) {
    if (!tags || tags.length === 0) {
        console.error('[Rule34Client] No tags provided for search.');
        return null;
    }

    const tagString = tags.join('+'); // rule34 uses '+' for tag separation in API
    const params = {
        page: 'dapi',
        s: 'post',
        q: 'index',
        tags: tagString,
        limit: Math.min(limit, 1000), // Ensure limit doesn't exceed API max
        pid: pid,
        json: 1, // Request JSON response
    };

    try {
        console.log(`[Rule34Client] Searching posts with tags: ${tagString}, Limit: ${limit}, Page: ${pid}`);
        const response = await axios.get(API_BASE_URL, { params });

        // rule34 returns an empty string "" for no results, or an array for results.
        if (response.data === "" || response.data === null) {
            console.log(`[Rule34Client] No posts found on page ${pid} for tags: ${tagString}`);
            return []; 
        }
        
        // Ensure the response is actually an array before returning
        if (Array.isArray(response.data)) {
            console.log(`[Rule34Client] Found ${response.data.length} posts on page ${pid} for tags: ${tagString}`);
            return response.data;
        } else {
            console.warn(`[Rule34Client] Received unexpected non-array response for page ${pid}, tags: ${tagString}`, response.data);
            return []; // Return empty array on unexpected format
        }

    } catch (error) {
        console.error(`[Rule34Client] Error fetching posts on page ${pid} for tags "${tagString}":`, error.response ? error.response.status : error.message);
        // Handle potential rate limits or other errors
        return null; // Indicate an error occurred
    }
}

/**
 * Fetches the highest-scoring image result for given tags across multiple pages, intended for avatar use.
 * Prefers the preview URL for size efficiency.
 * @param {string[]} tags - An array of tags to search for.
 * @param {number} [numPages=5] - The number of pages (starting from 0) to search across.
 * @param {number} [limitPerPage=30] - Number of posts to fetch per page.
 * @returns {Promise<string | null>} A promise that resolves to a preview image URL or null if not found/error.
 */
async function fetchTopPostImageUrl(tags, numPages = 5, limitPerPage = 30) {
    if (!tags || tags.length === 0) {
        console.error('[Rule34Client] No tags provided for avatar search.');
        return null;
    }

    const searchTags = [...tags, 'sort:score:desc', 'type:image'];
    let allPosts = [];
    const tagStringForLog = tags.join('+'); // For logging clarity

    console.log(`[Rule34Client] Starting multi-page avatar search for tags: ${tagStringForLog} (Pages: 0-${numPages - 1}, Limit/Page: ${limitPerPage})`);

    // Fetch posts from multiple pages
    for (let pageNum = 0; pageNum < numPages; pageNum++) {
        const postsFromPage = await searchPosts(searchTags, limitPerPage, pageNum);
        if (postsFromPage === null) {
             // Error occurred during fetch, maybe stop or just log and continue?
             console.error(`[Rule34Client] Error fetching avatar posts from page ${pageNum}. Skipping page.`);
             continue; // Continue to next page on error
        }
        if (postsFromPage.length > 0) {
             allPosts = allPosts.concat(postsFromPage);
        } else {
            // No more posts found on this page, likely reached the end of results
            console.log(`[Rule34Client] No more posts found on page ${pageNum}, stopping multi-page search early.`);
            break; // Stop fetching further pages
        }
    }

    if (allPosts.length === 0) {
        console.warn(`[Rule34Client] No image posts found across ${numPages} pages for avatar search with tags: ${tagStringForLog}`);
        return null;
    }

    // Sort the combined list by score descending (API sorts per page, but this ensures overall sorting)
    allPosts.sort((a, b) => parseInt(b.score, 10) - parseInt(a.score, 10));

    console.log(`[Rule34Client] Found ${allPosts.length} total candidate posts across searched pages. Finding best URL...`);

    // Find the highest scoring post with a usable preview/file URL
    for (const post of allPosts) {
        if (post.preview_url && isDirectImagePreviewUrl(post.preview_url)) {
            console.log(`[Rule34Client] Found avatar preview URL for post ID ${post.id} (Score: ${post.score}, From Page: ${post.pid || 'unknown'})`); // post.pid might not be available if R34 API doesn't return it
            return post.preview_url;
        }
        if (post.file_url && isDirectImagePreviewUrl(post.file_url)) {
            console.warn(`[Rule34Client] Using file_url as fallback avatar for post ID ${post.id} (Score: ${post.score}, From Page: ${post.pid || 'unknown'})`);
            return post.file_url;
        }
    }

    // If loop finishes, no suitable image URL found in the combined posts
    console.warn(`[Rule34Client] No posts with suitable preview/file URL found in combined ${allPosts.length} results for tags: ${tagStringForLog}`);
    return null;
}

// Helper function to check if a URL is likely a static image (for previews)
function isDirectImagePreviewUrl(url) {
    if (!url) return false;
    return url.match(/\.(jpeg|jpg|gif|png|webp)$/i) != null;
}

module.exports = {
    searchPosts,
    fetchTopPostImageUrl,
}; 