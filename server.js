const express = require('express');
const cors = require('cors');
const sgMail = require('@sendgrid/mail');
const fetch = require('node-fetch');

const app = express();

// ── Config ──
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'angela@ebiresults.com';
const REPLY_TO = process.env.REPLY_TO || 'ebipartnersorg@gmail.com';
const CLOSE_API_KEY = process.env.CLOSE_API_KEY;

sgMail.setApiKey(SENDGRID_API_KEY);

app.use(cors());
app.use(express.json());

// Serve static files
app.use(express.static(__dirname));

// ── API: Capture lead ────────────────────────────────────
app.post('/api/scan-lead', async (req, res) => {
  try {
    const { url, email, name, phone } = req.body;

    // Push to Close CRM
    const body = {
      name: name || email.split('@')[0],
      contacts: [
        {
          name: name || email.split('@')[0],
          emails: [{ type: 'office', email }],
          phones: phone ? [{ type: 'office', phone }] : []
        }
      ],
      "custom.lf_cf_custom_website": url || '',
      "custom.lf_cf_custom_funnel_source": 'web-scanner',
      description: `Requested AI Readiness scan for ${url}`
    };

    const res = await fetch('https://api.close.com/api/v1/lead/', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(CLOSE_API_KEY + ':').toString('base64')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = await res.text();
    console.log(`✅ Lead captured for scan: ${email} scanning ${url}`);

  } catch (err) {
    console.error('Lead capture error:', err.message);
  }

  res.json({ success: true });
});

// ── API: Run the scan ─────────────────────────────────────
app.post('/api/run-scan', async (req, res) => {
  try {
    const { url, email, name, phone } = req.body;
    const cleanUrl = url.replace(/\/$/, '');  // Remove trailing slash

    const result = { score: 0, crawlable: 'bad', schema: 'bad', gbp: 'bad', content: 'bad', llms: 'bad', citations: 'bad' };

    // ── Check 1: AI Crawlability ──
    try {
      const robotsRes = await fetch(cleanUrl + '/robots.txt', { timeout: 8000 });
      const robotsText = await robotsRes.text();
      if (robotsRes.ok && !robotsText.toLowerCase().includes('disallow: /')) {
        result.crawlable = 'good';
      } else if (robotsRes.ok) {
        result.crawlable = 'warn';
      }
    } catch (e) {
      result.crawlable = 'warn';
    }

    // ── Check 2: llms.txt ──
    try {
      const llmsRes = await fetch(cleanUrl + '/llms.txt', { timeout: 8000 });
      if (llmsRes.ok && (await llmsRes.text()).length > 20) {
        result.llms = 'good';
      }
    } catch (e) {}

    // ── Check 3: Schema Markup ──
    try {
      const pageRes = await fetch(cleanUrl, { timeout: 10000 });
      const html = await pageRes.text();
      if (html.includes('application/ld+json') || html.includes('itemscope') || html.includes('itemtype')) {
        result.schema = 'good';
      } else if (html.includes('schema.org') || html.includes('LocalBusiness')) {
        result.schema = 'good';
      } else {
        result.schema = 'bad';
      }

      // ── Check 4: AI-Friendly Content ──
      const bodyText = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      const wordCount = bodyText.split(' ').length;
      if (wordCount > 800) {
        result.content = 'good';
      } else if (wordCount > 300) {
        result.content = 'warn';
      }
    } catch (e) {
      result.schema = 'bad';
      result.content = 'bad';
    }

    // ── Check 5: Google Business Profile (extract from HTML) ──
    try {
      const gbpRes = await fetch(cleanUrl, { timeout: 8000 });
      const gbpHtml = await gbpRes.text();
      if (gbpHtml.includes('LocalBusiness') || gbpHtml.includes('PostalAddress') || gbpHtml.includes('business-hours')) {
        result.gbp = 'good';
      } else if (gbpHtml.includes('address') || gbpHtml.includes('phone')) {
        result.gbp = 'warn';
      }
    } catch (e) {}

    // ── Check 6: Citation Consistency (check for NAP on page) ──
    try {
      const citeRes = await fetch(cleanUrl, { timeout: 8000 });
      const citeHtml = await citeRes.text();
      const lower = citeHtml.toLowerCase();
      let found = 0;
      if (lower.match(/\d{3}[-.]?\d{3}[-.]?\d{4}/)) found++;  // Phone
      if (lower.includes('@')) found++;  // Email
      if (lower.match(/\d+\s+\w+\s+\w+/)) found++;  // Street address
      result.citations = found >= 3 ? 'good' : found >= 2 ? 'warn' : 'bad';
    } catch (e) {}

    // ── Calculate Score ──
    const scores = {
      crawlable: result.crawlable === 'good' ? 20 : result.crawlable === 'warn' ? 10 : 0,
      schema: result.schema === 'good' ? 20 : result.schema === 'warn' ? 10 : 0,
      gbp: result.gbp === 'good' ? 20 : result.gbp === 'warn' ? 10 : 0,
      content: result.content === 'good' ? 15 : result.content === 'warn' ? 8 : 0,
      llms: result.llms === 'good' ? 15 : result.llms === 'warn' ? 8 : 0,
      citations: result.citations === 'good' ? 10 : result.citations === 'warn' ? 5 : 0
    };

    result.score = Object.values(scores).reduce((a, b) => a + b, 0);

    // ── Send email report ──
    try {
      await sendEmailReport({ to: email, name: name || 'Business Owner', url: cleanUrl, result });
      console.log(`✅ Report emailed to ${email}`);
    } catch (e) {
      console.error('Email send failed:', e.message);
    }

    // ── Send SMS report (if phone provided) ──
    if (phone) {
      try {
        const msg = {
          to: phone.replace(/[^0-9+]/g, ''),
          from: { email: FROM_EMAIL, name: 'AI Readiness Scanner' },
          subject: 'Your AI Readiness Score: ' + result.score + '/100',
          text: `AI Readiness Score for ${cleanUrl}: ${result.score}/100\n\nCategories:\n🤖 Crawlability: ${result.crawlable}\n🏷️ Schema: ${result.schema}\n📍 GBP: ${result.gbp}\n✍️ Content: ${result.content}\n📄 llms.txt: ${result.llms}\n🔗 Citations: ${result.citations}\n\nFull report emailed to ${email}\n\n- AI Readiness Scanner`
        };
        await sgMail.send(msg);
        console.log(`✅ SMS report sent to ${phone}`);
      } catch (e) {
        console.error('SMS send failed:', e.message);
      }
    }

    res.json(result);

  } catch (err) {
    console.error('Scan error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── SendGrid Email Report ────────────────────────────────
async function sendEmailReport({ to, name, url, result }) {
  const scoreClass = result.score < 40 ? 'low' : result.score < 70 ? 'medium' : 'high';
  const color = scoreClass === 'high' ? '#22c55e' : scoreClass === 'medium' ? '#f59e0b' : '#ef4444';
  const summary = result.score < 40 ? 'Needs significant work' : result.score < 70 ? 'Room for improvement' : 'Looking good';

  const catRows = [
    { icon: '🤖', label: 'AI Crawlability', status: result.crawlable },
    { icon: '🏷️', label: 'Schema Markup', status: result.schema },
    { icon: '📍', label: 'Google Business Profile', status: result.gbp },
    { icon: '✍️', label: 'AI-Friendly Content', status: result.content },
    { icon: '📄', label: 'llms.txt Priority', status: result.llms },
    { icon: '🔗', label: 'Citation Consistency', status: result.citations }
  ].map(c => `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;">${c.icon} ${c.label}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:600;color:${c.status === 'good' ? '#22c55e' : c.status === 'warn' ? '#f59e0b' : '#ef4444'}">${c.status === 'good' ? '✅ Good' : c.status === 'warn' ? '⚠️ Needs Work' : '❌ Missing'}</td></tr>`).join('');

  const msg = {
    to,
    from: { email: FROM_EMAIL, name: 'AI Readiness Scanner' },
    replyTo: REPLY_TO,
    subject: `AI Readiness Score: ${result.score}/100 — ${url}`,
    html: `
      <div style="max-width:600px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#e2e8f0;padding:32px;border-radius:16px;">
        <h2 style="margin:0 0 8px;color:#f8fafc;">🔍 AI Readiness Scan Complete</h2>
        <p style="color:#94a3b8;margin:0 0 24px;">${url}</p>

        <div style="text-align:center;margin-bottom:24px;">
          <div style="display:inline-block;width:100px;height:100px;border-radius:50%;border:6px solid ${color};display:flex;align-items:center;justify-content:center;font-size:36px;font-weight:800;color:${color};margin:0 auto 8px;">${result.score}</div>
          <p style="color:#94a3b8;font-size:14px;">${summary}</p>
        </div>

        <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
          ${catRows}
        </table>

        <p style="color:#94a3b8;font-size:14px;margin-bottom:24px;">
          Visit <a href="https://ai-readiness-funnel-production.up.railway.app/" style="color:#6366f1;">AI Search Readiness</a> to get the full done-for-you setup.
        </p>

        <hr style="border:none;border-top:1px solid #1e293b;margin:24px 0;">
        <p style="font-size:12px;color:#475569;">This scan is read-only. We don't modify your website. Results were also saved to our system.</p>
      </div>`
  };
  await sgMail.send(msg);
}

// ── Start ──
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ AI Scanner server running on port ${PORT}`);
  console.log(`📧 From: ${FROM_EMAIL}`);
  console.log(`📄 Endpoints: /api/scan-lead, /api/run-scan`);
});
