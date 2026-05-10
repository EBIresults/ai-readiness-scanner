const express = require('express');
const cors = require('cors');
const sgMail = require('@sendgrid/mail');
const fetch = require('node-fetch');

const app = express();

// ── Config (ALL from env vars — never hardcoded) ──
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'angela@ebiresults.com';
const REPLY_TO = process.env.REPLY_TO || 'ebipartnersorg@gmail.com';
const CLOSE_API_KEY = process.env.CLOSE_API_KEY;
const RENEE_EMAIL = '14calder@gmail.com';

sgMail.setApiKey(SENDGRID_API_KEY);

app.use(cors());
app.use(express.json());

// Serve static files
app.use(express.static(__dirname));

// ── Helper: Push lead to Close CRM ─────────────────────────
async function pushToClose({ name, email, phone, url, score, issues, scannedBy }) {
  if (!CLOSE_API_KEY) {
    console.log('⚠️ Close API key not configured — skipping CRM push');
    return null;
  }

  // Determine tag based on who initiated the scan
  const isReneeScan = scannedBy === 'renee' ||
    (email && email.toLowerCase() === RENEE_EMAIL.toLowerCase());

  const pipelineId = 'Truh7BlF8e15iIX0n9rFNkVBwVx8O0u4N7Jw5vWCSvd'; // The only pipeline ID from Close
  const statusType = isReneeScan ? 'Potential' : 'HOT LEAD';

  const body = {
    name: name || email?.split('@')[0] || 'Unknown Lead',
    contacts: [
      {
        name: name || email?.split('@')[0] || 'Unknown',
        emails: email ? [{ type: 'office', email }] : [],
        phones: phone ? [{ type: 'office', phone }] : []
      }
    ],
    "custom.lf_cf_custom_website": url || '',
    "custom.lf_cf_custom_funnel_source": 'AI Readiness Funnel',
    "custom.lf_cf_custom_ai_readiness_score": String(score || 0),
    "custom.lf_cf_custom_issues_found": String(issues || 0),
    description: `Scan Type: ${isReneeScan ? 'Renee Scan' : 'Self Scan'}\nWebsite: ${url}\nAI Readiness Score: ${score}/100\nIssues: ${issues}\nTag: ${isReneeScan ? 'Renee Scan → Nurture (testing)' : 'Self Scan → HOT LEAD'}`
  };

  try {
    const response = await fetch('https://api.close.com/api/v1/lead/', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(CLOSE_API_KEY + ':').toString('base64')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    if (response.ok) {
      console.log(`✅ Close CRM: Lead created — ${name} (${isReneeScan ? 'Renee Scan → HOT LEAD' : 'Self Scan → Nurture'})`);
      console.log(`   Lead ID: ${data.id}`);
      return data;
    } else {
      console.error('❌ Close CRM error:', JSON.stringify(data).substring(0, 200));
      return null;
    }
  } catch (err) {
    console.error('❌ Close CRM push failed:', err.message);
    return null;
  }
}

// ── API: Scan + Push to Close ─────────────────────────────
app.post('/api/scan', async (req, res) => {
  try {
    const { url, email, name, phone, scannedBy } = req.body;
    const cleanUrl = url?.replace(/\/$/, '');
    if (!cleanUrl) return res.status(400).json({ error: 'URL required' });

    // ── Run scan (same logic as /api/run-scan) ──
    const result = { score: 0, categories: {} };
    const issues = [];

    try {
      const pageRes = await fetch(cleanUrl, { timeout: 10000 });
      const html = await pageRes.text();
      const bodyText = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      const wordCount = bodyText.split(' ').length;

      // llms.txt
      try {
        const llmsRes = await fetch(cleanUrl + '/llms.txt', { timeout: 5000 });
        if (llmsRes.ok && (await llmsRes.text()).length > 20) {
          result.categories.llms = { status: 'good', label: 'llms.txt found' };
        } else {
          result.categories.llms = { status: 'bad', label: 'No llms.txt', points: 15 };
          issues.push('Missing llms.txt');
        }
      } catch(e) {
        result.categories.llms = { status: 'bad', label: 'No llms.txt', points: 15 };
        issues.push('Missing llms.txt');
      }

      // Schema
      const hasSchema = html.includes('application/ld+json') || html.includes('itemscope') || html.includes('itemtype') || html.includes('schema.org');
      result.categories.schema = hasSchema
        ? { status: 'good', label: 'Schema found' }
        : { status: 'bad', label: 'No schema markup', points: 20 };

      if (!hasSchema) issues.push('No schema markup');

      // Content
      if (wordCount > 800) result.categories.content = { status: 'good', label: `${wordCount} words` };
      else if (wordCount > 300) result.categories.content = { status: 'warn', label: `${wordCount} words (needs more)`, points: 8 };
      else {
        result.categories.content = { status: 'bad', label: `${wordCount} words (too thin)`, points: 15 };
        issues.push(`Thin content (${wordCount} words)`);
      }

      // Crawlability
      try {
        const robotsRes = await fetch(cleanUrl + '/robots.txt', { timeout: 5000 });
        const robotsText = await robotsRes.text();
        if (robotsRes.ok) {
          const blocked = robotsText.toLowerCase().includes('disallow: /') && !robotsText.includes('gptbot');
          result.categories.crawlability = blocked
            ? { status: 'bad', label: 'AI crawlers may be blocked', points: 10 }
            : { status: 'good', label: 'AI crawlers allowed' };
        } else {
          result.categories.crawlability = { status: 'warn', label: 'No robots.txt', points: 5 };
        }
      } catch(e) {
        result.categories.crawlability = { status: 'warn', label: 'No robots.txt', points: 5 };
      }

      // FAQ content
      const hasFAQ = html.toLowerCase().includes('faq') || html.toLowerCase().includes('frequently asked');
      if (!hasFAQ) {
        result.categories.faq = { status: 'bad', label: 'No FAQ content', points: 10 };
        issues.push('No FAQ content');
      } else {
        result.categories.faq = { status: 'good', label: 'FAQ found' };
      }

      // H1
      const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      if (!h1Match) {
        result.categories.h1 = { status: 'bad', label: 'Missing H1 heading', points: 5 };
        issues.push('Missing H1 heading');
      } else {
        result.categories.h1 = { status: 'good', label: `H1: ${h1Match[1].replace(/<[^>]+>/g,'').trim().substring(0,40)}` };
      }

      // Sitemap
      try {
        const smRes = await fetch(cleanUrl + '/sitemap.xml', { timeout: 5000 });
        if (!smRes.ok) {
          result.categories.sitemap = { status: 'bad', label: 'No sitemap.xml', points: 5 };
          issues.push('No sitemap.xml');
        } else {
          result.categories.sitemap = { status: 'good', label: 'Sitemap found' };
        }
      } catch(e) {
        result.categories.sitemap = { status: 'bad', label: 'No sitemap.xml', points: 5 };
        issues.push('No sitemap.xml');
      }

      // GBP
      const hasGBP = html.includes('google.com/maps') || html.includes('place_id') || html.includes('LocalBusiness');
      if (!hasGBP) {
        result.categories.gbp = { status: 'warn', label: 'No GBP reference on page', points: 5 };
      } else {
        result.categories.gbp = { status: 'good', label: 'GBP referenced' };
      }

    } catch (err) {
      return res.status(502).json({ error: `Cannot reach ${cleanUrl} — ${err.message}` });
    }

    // Calculate score
    const deductions = Object.values(result.categories)
      .filter(c => c.points)
      .reduce((sum, c) => sum + c.points, 0);
    result.score = Math.max(0, 100 - deductions);
    result.issues = issues;
    result.issueCount = issues.length;

    // ── Push to Close CRM ──
    if (email || name || phone) {
      const scannedByValue = scannedBy || (email === RENEE_EMAIL ? 'renee' : 'self');
      await pushToClose({
        name: name || email?.split('@')[0],
        email,
        phone,
        url: cleanUrl,
        score: result.score,
        issues: issues.length,
        scannedBy: scannedByValue
      });
    }

    // ── Send email report ──
    if (email) {
      try {
        await sendReport({
          to: email,
          name: name || 'Business Owner',
          url: cleanUrl,
          result
        });
      } catch(e) {
        console.error('Email send failed:', e.message);
      }
    }

    res.json(result);

  } catch (err) {
    console.error('Scan error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Capture lead (lightweight — used from scan.html form) ──
app.post('/api/lead', async (req, res) => {
  try {
    const { url, email, name, phone, scannedBy } = req.body;
    await pushToClose({
      name: name || email?.split('@')[0],
      email,
      phone,
      url,
      score: 0,
      issues: 0,
      scannedBy: scannedBy || 'self'
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Lead capture error:', err.message);
    res.json({ success: false });
  }
});

// ── Email Report ─────────────────────────────────────────
async function sendReport({ to, name, url, result }) {
  const color = result.score < 40 ? '#ef4444' : result.score < 70 ? '#f59e0b' : '#22c55e';
  const summary = result.score < 40 ? 'Needs critical fixes' : result.score < 70 ? 'Room for improvement' : 'Looking good';

  const catHtml = Object.entries(result.categories).map(([key, val]) => {
    const dot = val.status === 'good' ? '✅' : val.status === 'warn' ? '⚠️' : '❌';
    const pts = val.points ? ` (−${val.points})` : '';
    return `<tr><td style="padding:6px 10px;border-bottom:1px solid #334155;color:#94a3b8;">${dot} ${key}</td><td style="padding:6px 10px;border-bottom:1px solid #334155;color:#e2e8f0;text-align:right;">${val.label}${pts}</td></tr>`;
  }).join('');

  const msg = {
    to,
    from: { email: FROM_EMAIL, name: 'AI Readiness Scanner' },
    replyTo: REPLY_TO,
    subject: `AI Readiness Score: ${result.score}/100 — ${url}`,
    html: `
      <div style="max-width:560px;margin:0 auto;font-family:Georgia,serif;background:#f8f7f4;color:#2c3e2d;padding:28px;border-radius:8px;">
        <h2 style="color:#3a5a3a;margin:0 0 4px;">🔍 AI Readiness Scan Complete</h2>
        <p style="color:#5a7a5a;margin:0 0 20px;">${url}</p>
        <div style="text-align:center;margin-bottom:20px;">
          <div style="display:inline-block;width:80px;height:80px;border-radius:50%;border:5px solid ${color};line-height:80px;font-size:28px;font-weight:800;color:${color};">${result.score}</div>
          <p style="color:#5a7a5a;font-size:14px;">${summary}</p>
          ${result.issues.length > 0 ? `<p style="color:#b87333;font-size:13px;">${result.issues.length} issue${result.issues.length > 1 ? 's' : ''} found</p>` : ''}
        </div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">${catHtml}</table>
        ${result.issues.length > 0 ? `<p style="font-size:12px;color:#5a7a5a;text-align:center;">See your full report with step-by-step DIY fixes → <a href="#" style="color:#b87333;">FIX THIS NOW</a></p>` : ''}
        <hr style="border:none;border-top:1px solid #d4ddd4;margin:16px 0;">
        <p style="font-size:11px;color:#8b9d8b;text-align:center;">— Angela, EBI Results | angela@ebiresults.com</p>
      </div>`
  };
  await sgMail.send(msg);
}

// ── Start ──
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ AI Scanner server running on port ${PORT}`);
  console.log(`📧 From: ${FROM_EMAIL}`);
  console.log(`📄 Endpoints: POST /api/scan, POST /api/lead`);
});
