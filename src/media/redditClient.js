const axios = require('axios');
const { sample } = require('../utils/random'); // Assuming a utility for random sampling

// Cache to avoid re-fetching the same subreddit top posts too quickly
// Key format: subreddit:timeframe (e.g., "GoonforAlice:all")
const subredditCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes TTL for top/all

/**
 * Fetches the top posts from a given subreddit for a specified timeframe.
 * Uses a simple time-based cache.
 * @param {string} subreddit The name of the subreddit.
 * @param {number} [limit=100] The number of posts to fetch (Reddit API max is 100 per request).
 * @param {string} [timeframe='day'] Timeframe for top posts (e.g., 'hour', 'day', 'week', 'month', 'year', 'all').
 * @param {string|null} [after=null] The `after` parameter for pagination (fetches posts after this ID).
 * @returns {Promise<{posts: Array<object>, after: string | null} | null>} An object containing posts and the next `after` ID, or null on error.
 */
async function getSubredditTopPosts(subreddit, limit = 100, timeframe = 'day', after = null) {
    const cacheKey = `${subreddit}:${timeframe}:${after || 'start'}`;
    const now = Date.now();
    const cacheEntry = subredditCache.get(cacheKey);

    // Use cache only if fetching the first page (after=null)
    if (!after && cacheEntry && now - cacheEntry.timestamp < CACHE_TTL) {
        console.log(`[RedditClient] Using cached posts for r/${subreddit} (t=${timeframe})`);
        return cacheEntry.data;
    }

    const url = `https://www.reddit.com/r/${subreddit}/top.json?t=${timeframe}&limit=${limit}${after ? `&after=${after}` : ''}`;
    console.log(`[RedditClient] Fetching top posts from r/${subreddit} (t=${timeframe}, limit=${limit}, after=${after || 'None'})`);

    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Goon34DiscordBot/1.0', // Reddit requires a User-Agent
            },
        });

        if (response.data && response.data.data && response.data.data.children) {
            const posts = response.data.data.children.map(child => child.data);
            const nextAfter = response.data.data.after; // Get the 'after' for pagination
            const resultData = { posts, after: nextAfter };
            
            // Only cache the first page result
            if (!after) {
                subredditCache.set(cacheKey, { data: resultData, timestamp: now });
            }
            console.log(`[RedditClient] Found ${posts.length} posts in r/${subreddit} (t=${timeframe}), next after: ${nextAfter}`);
            return resultData;
        } else {
            console.warn(`[RedditClient] No posts found or unexpected format for r/${subreddit} (t=${timeframe})`);
            return { posts: [], after: null }; // Return empty structure
        }
    } catch (error) {
        console.error(`[RedditClient] Error fetching from r/${subreddit} (t=${timeframe}):`, error.response ? error.response.status : error.message);
        if (error.response && error.response.status === 404) {
            console.warn(`[RedditClient] Subreddit r/${subreddit} not found (404).`);
            // Cache the miss for the first page
             if (!after) {
                subredditCache.set(cacheKey, { data: { posts: [], after: null }, timestamp: now });
             }
        }
        return null; // Indicate error
    }
}

/**
 * Checks if a Reddit post object represents suitable media (image or specific video types).
 * @param {object} post The Reddit post data object.
 * @returns {boolean} True if the post contains suitable media.
 */
function isSuitableRedditMediaPost(post) {
    if (!post || post.is_self || post.stickied || post.is_gallery) {
        return false; // Exclude self-posts, stickied, galleries
    }
    // Basic check for direct image links
    if (post.url && post.url.match(/\.(jpeg|jpg|gif|png|webp)$/i)) {
        return true;
    }
    // Check for specific video hosts if needed (e.g., Redgifs) - needs more specific logic
    // if (post.is_video && post.media && post.media.reddit_video) {
    //     return true; // Standard Reddit video
    // }
    // Example: Add Redgifs check if necessary
    // if (post.domain === 'redgifs.com' && post.preview?.reddit_video_preview?.fallback_url) {
    //      return true
    // }

    // Add more checks for other desired video types if needed
    return false;
}

// --- NEW FUNCTION ---
/**
 * Fetches a random suitable image URL from the 'top' (all time) posts of a randomly selected subreddit from the provided list.
 * @param {string[]} subreddits Array of subreddit names.
 * @returns {Promise<string|null>} A promise resolving to a suitable image URL, or null if none found or on error.
 */
async function fetchRandomTopRedditImageUrl(subreddits) {
    if (!subreddits || subreddits.length === 0) {
        console.warn('[RedditClient] fetchRandomTopRedditImageUrl called with no subreddits.');
        return null;
    }

    const selectedSubreddit = sample(subreddits); // Pick a random subreddit
    if (!selectedSubreddit) return null;

    console.log(`[RedditClient] Attempting to fetch random top image from r/${selectedSubreddit} (all time)`);

    try {
        // Fetch top posts (all time, limit 100 is usually enough for variety)
        const result = await getSubredditTopPosts(selectedSubreddit, 100, 'all');

        if (result && result.posts && result.posts.length > 0) {
            const suitablePosts = result.posts.filter(isSuitableRedditMediaPost);

            if (suitablePosts.length > 0) {
                const randomPost = sample(suitablePosts); // Pick a random suitable post
                const imageUrl = randomPost?.url;
                if (imageUrl) {
                    console.log(`[RedditClient] Selected random top image URL: ${imageUrl}`);
                    return imageUrl;
                }
            } else {
                console.warn(`[RedditClient] No suitable media posts found in top 'all' for r/${selectedSubreddit}`);
            }
        } else {
             console.warn(`[RedditClient] No posts returned or error fetching top 'all' for r/${selectedSubreddit}`);
        }
    } catch (error) {
        console.error(`[RedditClient] Error in fetchRandomTopRedditImageUrl for r/${selectedSubreddit}:`, error);
    }

    console.warn(`[RedditClient] Failed to fetch a random top image URL from r/${selectedSubreddit}.`);
    return null; // Return null if no suitable image found or on error
}
// --- END NEW FUNCTION ---

module.exports = {
    getSubredditTopPosts,
    isSuitableRedditMediaPost,
    fetchRandomTopRedditImageUrl, // <<< Export the new function
}; 