# AI Readiness Scanner Tool

## What It Is
A single-business scan page at `agency.ebiresults.com`. Anyone can enter a URL + email (and optional name + phone) and get an instant AI Readiness Score across 6 categories. Results are delivered via email and SMS.

## Files
- `scan.html` — The frontend scan form (dark theme, matches branding)
- `server.js` — Express server with scan logic + SendGrid email + SMS + Close CRM push

## Deployment Steps

### 1. Deploy to Railway or VPS
This is a separate Node app (not the same as your AI Readiness funnel). You can either:
- **Option A:** Deploy as a new Railway project (preferred — keeps it independent)
- **Option B:** Run on a VPS with PM2

### 2. Set Environment Variables on the deployment
- `SENDGRID_API_KEY` — already set in code as fallback, but set as env var
- `CLOSE_API_KEY` — already set in code as fallback, but set as env var

### 3. Point DNS
**IMPORTANT — DO NOT SKIP:**
Go to your domain DNS settings for `agency.ebiresults.com` and point it to wherever you deploy this app (Railway or VPS IP).

### 4. Install dependencies on the server
```
npm install express cors @sendgrid/mail node-fetch
```

### 5. Start the server
```
node server.js
```

## How SMS Delivery Works
- The server uses SendGrid's email-to-SMS gateway
- If a phone number is provided, a text-only email is sent to the carrier's SMS gateway
- Supported carriers (US): Verizon (vtext.com), T-Mobile (tmomail.net), AT&T (txt.att.net)
- For best results, user should enter full number with area code

## Pricing Recommendation
Use this as a **$7 tool** (same price as your AI Readiness Scan). The puppy dog close works at $7 — cheap enough to try, expensive enough to qualify the lead.

To add payment: drop a Stripe Checkout token sale in front of it (similar to how checkout.html works).
