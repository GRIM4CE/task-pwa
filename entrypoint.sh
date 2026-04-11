#!/bin/sh
set -e

# Run database migrations on startup
echo "Running database migrations..."
cd /app
tsx src/db/migrate.ts
echo "Migrations complete."

# Start Next.js
echo "Starting Next.js..."
exec node server.js
