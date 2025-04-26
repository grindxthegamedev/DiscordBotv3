# Goon34 Discord Bot

## Description
An NSFW Discord bot named Goon34 that roleplays as notable characters or consenting adult actresses, delivering Jerk Off Instruction (JOI) scripts and media in DM sessions.

## Key Components
1. Discord.js Setup
2. Command & Interaction Handling
3. LLM Integration (Google Gemini)
4. Media Fetching (Reddit API)
5. Webhook-based Character Impersonation
6. Session & Task Scheduler
7. Activity Checker & Controls
8. Authentication & API Key Management
9. Concurrency & Scalability
10. Logging & Monitoring
11. Plugin-Style Character Packs (dynamic character definitions: prompts, subreddits, metadata)
12. Memory & Persistence (session IDs, user preference storage, cross-session recall)

## User Flow
1. User selects a "Waifu" character and provides preferences.
2. Bot sends initial DM with consent and instructions.
3. Bot spins up a webhook mimicking the selected character.
4. LLM generates the first 10–20 lines of a JOI script. Dynamic creation after.
5. Bot sends media every 5 seconds and JOI instructions every 5–10 seconds for the chosen duration.
6. Bot periodically checks user activity by sending a button every 5–10 minutes. Disables session on timeout.
7. Bot ends session with a closing script when duration completes or user stops via button.

## Comprehensive Task List

1. Project Initialization
    1a. Initialize Node.js project (`npm init`)
    1b. Install dependencies: `discord.js`, `dotenv`, `axios`, `@google-cloud/*` (Gemini), `node-cron` or similar
    1c. Create and configure `.env` with Discord token, LLM keys, Reddit credentials
    1d. Initialize Git repository and make initial commit

2. Command & Interaction Handling
    2a. Define slash command schemas: `/start-session`, `/stop-session`, `/list-characters`
    2b. Register commands via Discord REST in `deploy-commands.ts`
    2c. Implement command handler modules in `src/commands/`
    2d. Set up `interactionCreate` event listener in `src/events/interactionCreate.ts`

3. LLM Integration
    3a. Design API key rotation strategy (load keys, cycle on errors)
    3b. Implement `GeminiClient` wrapper in `src/llm/client.ts`
    3c. Create prompt templates incorporating user preferences
    3d. Add retry and error-handling logic for LLM calls

4. Media Fetching
    4a. Build Reddit API client in `src/media/redditClient.ts`
    4b. Map characters to approved subreddit lists
    4c. Implement functions to fetch random image/video URLs
    4d. Enforce NSFW permission checks and filter duplicates

5. Webhook Character Impersonation
    5a. In DM channels, call `channel.createWebhook(name, options)` to impersonate character
    5b. Store webhook ID/token in session context for reuse
    5c. Delete or disable webhook on session end

6. Session Management
    6a. Define `Session` class in `src/sessions/Session.ts` (properties: userId, webhook, prefs, timers)
    6b. Implement `SessionManager` to manage active sessions
    6c. Schedule media/JOI dispatch with `setInterval` based on user timings
    6d. Enforce session duration limits and clean up on expiration

7. Activity Checker
    7a. Every 5–10 minutes, send an embed with a "Still there?" button
    7b. Listen for button interactions to reset inactivity timer
    7c. On 20s timeout, call session termination sequence

8. Interaction Controls
    8a. Attach "End Session" button component to each bot message
    8b. Handle end-session interactions to cancel timers and cleanup

9. Plugin-Style Character Packs
    15a. Define plugin schema (JSON/YAML) containing: LLM role prompt, subreddit list, personality metadata
    15b. Create `src/plugins/` loader to discover and validate plugin files at startup
    15c. Expose an admin or CLI command to add, remove, or list available character packs
    15d. Integrate plugin data into session initialization (choose character settings dynamically)

10. Memory & Persistence
    16a. Assign unique Session IDs for all active and historical sessions
    16b. Implement `src/utils/memory.ts` with read/write functions to a lightweight store (SQLite, JSON)
    16c. Store user preferences and previous session context for personalized follow‑ups
    16d. On new session start, load existing memory entries to prefill preferences
    16e. Implement pruning or TTL cleanup for old memory records

11. Error Handling & Abuse Prevention
    9a. Verify DM permissions; if blocked, prompt user in original channel
    9b. Implement per-user rate limiting (1 user message/minute)
    9c. Wrap external calls in try/catch with exponential backoff

12. Data Persistence (optional / YAGNI)
    10a. (Optional) Define SQLite schema for sessions, preferences, logs
    10b. Implement DB abstraction in `src/utils/db.ts`

13. Logging & Monitoring
    11a. Configure `winston` logger with console and file transports
    11b. Log session lifecycle events and errors
    11c. Expose basic metrics or integrate with monitoring service

14. Testing & Quality Assurance
    12a. Write unit tests for LLM client, media fetcher, and SessionManager
    12b. Configure `jest` and `ts-jest` in `package.json`
    12c. Create integration tests for slash commands against a test guild

15. Deployment & Scalability
    13a. Write `Dockerfile` to containerize the application
    13b. Create `docker-compose.yml` with environment injection
    13c. Add PM2 or Kubernetes manifests for process management and scaling

16. Documentation
    14a. Update `README.md` with setup, env vars, and usage examples
    14b. Move `Bot.md` into `docs/` and link from README
    14c. Document architecture and directory conventions



## Directory Structure (Proposed)
```plaintext
├── src/
│   ├── commands/
│   ├── events/
│   ├── llm/
│   ├── media/
│   ├── sessions/
│   ├── plugins/    # plugin packs for characters
│   └── utils/      # including memory.ts
├── docs/
│   └── Bot.md
├── README.md
└── .env
``` 