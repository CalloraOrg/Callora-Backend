# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Stage 2: Production Dependencies
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
# Exclude devDependencies (like TypeScript) to keep the image lightweight
RUN npm install --omit=dev

# Stage 3: Production Runtime
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Copy only the compiled assets and lean node_modules
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Enforce security by running as a non-root user
USER node

EXPOSE $PORT
CMD ["node", "dist/index.js"]