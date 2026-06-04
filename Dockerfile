# Stage 1: Build Go agent binaries
FROM golang:1.22-alpine AS agent-builder

WORKDIR /build
COPY agent/ .
COPY package.json /tmp/package.json

RUN go mod tidy && go mod download

# Extract version from package.json
RUN apk add --no-cache jq && \
    VERSION=$(cat /tmp/package.json | jq -r '.version') && \
    GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w -X main.version=${VERSION}" -o /out/unicentral-agent-windows-amd64.exe . && \
    GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w -X main.version=${VERSION}" -o /out/unicentral-agent-linux-amd64 . && \
    GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -ldflags="-s -w -X main.version=${VERSION}" -o /out/unicentral-agent-linux-arm64 .

# Stage 2: Node.js server
FROM node:20-alpine

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY server/ ./server/

# Copy compiled agent binaries from builder
COPY --from=agent-builder /out/ /app/releases/

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "server/server.js"]
