# Cost, Reliability, and Pricing Strategy

## 1. Reliability Strategy
**Your Question**: *If there is an error with rate limit checking, will the user be blocked?*

**Solution**: I have updated the code (`src/middleware/rateLimiter.js`) to **Fail Open**.
- **Normal Operation**: Checks Redis. If limit exceeded -> Block (429).
- **Redis Down/Error**: Logs the error internally, but **ALLOWS the user to proceed**.
- **Why?**: Better to lose a tiny bit of protection during an outage than to block legit users because *our* database is glitching.
- **RapidAPI**: Acts as the second layer of defense. Even if your internal limiter fails open, RapidAPI's gateway (which handles the billing quotas) is very stable and will stop users who exceed their monthly plan.

## 2. Estimated Running Costs (Monthly)

### Infrastructure (Railway)
| Item | Plan | Estimated Cost |
| :--- | :--- | :--- |
| **Compute** | Node.js (Standard) | ~$5.00 |
| **Database** | Redis (Base) | ~$5.00 |
| **TOTAL** | | **~$10.00 / month** |

### AI Costs (OpenAI `gpt-4o-mini`)
This model is extremely cheap and powerful.
- **Input**: $0.15 / 1M tokens
- **Output**: $0.60 / 1M tokens

**Scenario**: Average request is an article (1,000 words ≈ 1,500 tokens input) and a summary (200 words ≈ 300 tokens output).

**Cost Per Request**:
- Input: 1,500 / 1,000,000 * $0.15 = **$0.000225**
- Output: 300 / 1,000,000 * $0.60 = **$0.000180**
- **TOTAL**: **$0.000405 per request** (approx 0.04 cents)

## 3. Recommended Pricing Tiers (Profitability Analysis)

Goal: Maintain **80%+ Profit Margin**.

### BASIC (Free Tier)
- **Goal**: Marketing / Hook users.
- **Quota**: 100 requests / month.
- **Cost to You**: 100 * $0.0004 = **$0.04** (Negligible).
- **Tech Limit**: 1 req/sec (Prevent abuse).

### PRO ($5.00 / month)
- **Quota**: 2,500 requests / month.
- **Cost to You**: 2,500 * $0.0004 = **$1.01**.
- **Server Cost Share**: ~$0.20.
- **Total Cost**: ~$1.21.
- **Profit**: **$3.79 per user** (75% Margin).

### ULTRA ($50.00 / month)
- **Quota**: 50,000 requests / month.
- **Cost to You**: 50,000 * $0.0004 = **$20.25**.
- **Server Cost Share**: ~$1.00.
- **Total Cost**: ~$21.25.
- **Profit**: **$28.75 per user** (57% Margin).
- *Note*: High volume users might optimize inputs, effectively lowering your cost.

### MEGA ($150.00 / month)
- **Quota**: 200,000 requests / month.
- **Cost to You**: 200,000 * $0.0004 = **$81.00**.
- **Profit**: **$69.00 per user**.
- *Risk*: If they extract MASSIVE generic texts, margins verify.
- *Recommendation*: Set a "Fair Use" policy on text length (e.g., max 20,000 chars per request).

## 4. Production Readiness Checklist

1. **Environment Variables**:
   - Ensure `RAPIDAPI_PROXY_SECRET` is set in Railway.
   - Ensure `OPEN_AI_KEY` is set.

2. **RapidAPI Features**:
   - In RapidAPI "Definition", set headers to inject `x-rapidapi-proxy-secret`.
   - In "Monetization", create the plans (Basic, Pro, Ultra) matching the quotas above.

3. **Scaling**:
   - If you get 1000+ users, simply upgrade Railway to "Pro" (usage-based) and increase Redis memory. The code is stateless and ready to scale.
