# How to Publish to RapidAPI

## 1. Prerequisites
- The API must be deployed (e.g., on Railway) and have a public URL (e.g., `https://my-api.up.railway.app`).
- You must generate a strong random string to be your `RAPIDAPI_PROXY_SECRET`.
- Set this secret as an environment variable `RAPIDAPI_PROXY_SECRET` in your Railway project settings.

## 2. RapidAPI Dashboard Configuration
1. **Create API**: Go to RapidAPI Provider Dashboard > Add new API.
2. **Base URL**: Enter your Railway URL (e.g., `https://my-api.up.railway.app/api`).
3. **Security/Transformations (Crucial)**:
   - RapidAPI needs to authenticate itself to your backend.
   - Go to **Hub Settings** > **Gateway**.
   - Add a header transformation or simply ensure you add a **secret header** that is sent to your backend.
   - **Header Name**: `x-rapidapi-proxy-secret`
   - **Header Value**: `<YOUR_GENERATED_SECRET>` (The same one you put in Railway ENV).
   - *Note*: This prevents random people from bypassing RapidAPI and hitting your Railway app directly (free of charge).

## 3. Pricing Tiers
 RapidAPI handles the billing and quotas (Monthly requests).
 - Go to **Plans & Pricing**.
 - Define:
   - **Basic**: Free, 100 requests/month.
   - **Pro**: $5, 2000 requests/month.
   - **Ultra**: $50, 20,000 requests/month.
   
 **Tip**: You don't need to change code for this. RapidAPI Gateway will count the requests and block the user if they exceed their quota. Your code will never see the excess requests.

## 4. Endpoints Setup
 Define your endpoints in RapidAPI so users see them in the playground:
 - `GET /extract`
 - `GET /summarize`
 - `POST /summarize-text`
 - etc.

## 5. Testing
 Run internal tests before deploying:
 `npm test`
