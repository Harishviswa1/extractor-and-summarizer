# Enterprise AI Extraction & Summarization Platform

Production-ready API for extracting content, summarizing text, and monitoring RSS feeds, built with Node.js, Express, Redis, and OpenAI.

## Features

- **Smart Scraper**: Auto-fallback strategy (Fetch -> Playwright -> Proxy).
- **AI Powered**: Summarization, Headline Generation, Bias Comparison using GPT-4o-mini.
- **Enterprise Grade**: Rate limiting (Tiered), API Key Auth, Caching, Dockerized.
- **Real-time**: Socket.io updates for long-running jobs.

## Tech Stack

- **Framework**: Express.js
- **Database/Cache**: Redis (Used for Rate limits, Caching, Job Queue)
- **AI**: OpenAI API
- **Browser Automation**: Playwright

## Deployment Guide (Railway)

### Prerequisites

1. Fork/Clone this repository.
2. Create a Railway account.
3. Obtain OpenAI API Key.

### Steps

1. **Create New Project on Railway**
   - Click "New Project" > "Provision Redis" (This sets up the Redis database).
   - Click "New" > "GitHub Repo" > Select this repo.

2. **Configure Environment Variables**
   - Go to the Service (Repo) settings > Variables.
   - Add the following:
     - `OPEN_AI_KEY`: Your OpenAI Key.
     - `ADMIN_API_KEY`: Secret key for admin access.
     - `NODE_ENV`: `production`
     - `REDIS_URL`: Use the variable provided by Railway (usually `${{Redis.REDIS_URL}}`).

3. **Deploy**
   - Railway handles the Dockerfile automatically.
   - Wait for build to complete.

4. **Health Check**
   - Visit `https://your-app-url.up.railway.app/api/health` to verify.

## API Documentation

### Authentication
Header: `x-api-key: <YOUR_KEY>`

### Endpoints

- `GET /api/extract?url=...`
- `GET /api/summarize?url=...&style=bullet`
- `POST /api/summarize-text` (Body: `{ text: "..." }`)
- `POST /api/compare` (Body: `{ url1, url2 }`)
- `POST /api/rss-monitor` (Body: `{ url, webhook }`)

## Local Development

```bash
# Start Redis
docker-compose up -d redis

# Install dependencies
npm install

# Start Server
npm run dev
```
