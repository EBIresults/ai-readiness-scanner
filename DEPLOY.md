# AI Readiness Scanner — EBI Results
# Deploy this to Railway, Vercel, or a VPS

# ── Railway ──
# Create a new project on railway.app
# Point it to your GitHub repo (or deploy via CLI)
# Add these environment variables:
#   SENDGRID_API_KEY  (already has fallback in code)
#   CLOSE_API_KEY     (already has fallback in code)
#   PORT              (Railway sets this automatically)
#
# Then point agency.ebiresults.com CNAME to railway

# ── Vercel (Chad's way) ──
# Install Vercel CLI:
#   npm i -g vercel
# Run:
#   vercel
# Follow prompts. Add env vars in Vercel dashboard.
# Point agency.ebiresults.com CNAME to vercel

# ── Files in this project ──
# index.html   → Main EBI Results homepage with embedded scan tool
# scan.html    → Standalone scanner page (backup)
# server.js    → Express API: captures leads, runs scans, emails results
# package.json → Dependencies
# Procfile     → Railway start command
