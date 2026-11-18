# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source
COPY . .

# Vite needs these at build time
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_TELEGRAM_BOT

ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY
ENV VITE_TELEGRAM_BOT=$VITE_TELEGRAM_BOT

RUN npm run build

# Production stage
FROM node:22-alpine

WORKDIR /app

# Lightweight static file server
RUN npm install -g serve@14

COPY --from=builder /app/dist ./dist

# Railway injects PORT
ENV PORT=3000
EXPOSE 3000

# -s enables SPA fallback (all routes → index.html)
CMD ["sh", "-c", "serve -s dist -l ${PORT}"]
