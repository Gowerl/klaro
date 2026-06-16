# Stage 1: Build Frontend
FROM node:18-slim AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# Stage 2: Run Express Backend & Serve Frontend
FROM node:18-slim
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --only=production
COPY . .
# Kopiere das gebaute Frontend in das Backend-Verzeichnis
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist
EXPOSE 8080
CMD [ "npm", "start" ]
