# Build the web console (Vite SPA) for Railway
# Root Directory should be left EMPTY (repo root)

FROM node:22-alpine AS builder

WORKDIR /app

# Copy only the web app
COPY web/package.json web/package-lock.json ./
RUN npm ci

# Copy the rest of the web source
COPY web/ .

# Vite needs these at build time (set them as Railway Variables)
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_TELEGRAM_BOT

ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY
ENV VITE_TELEGRAM_BOT=$VITE_TELEGRAM_BOT

RUN npm run build

# Production stage – lightweight static server
FROM node:22-alpine

WORKDIR /app

RUN npm install -g serve@14

COPY --from=builder /app/dist ./dist

ENV PORT=3000
EXPOSE 3000

# -s = SPA mode (all routes fall back to index.html)
CMD ["sh", "-c", "serve -s dist -l ${PORT}"]
