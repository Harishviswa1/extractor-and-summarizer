FROM node:20-bookworm

# Install dependencies required for Playwright (Chromium)
RUN npx playwright install-deps chromium

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production

# Install Playwright browsers (Chromium only to save space)
RUN npx playwright install chromium

COPY . .

EXPOSE 3000

CMD ["node", "src/app.js"]
