const express = require('express');
const cors = require('cors');
const sgMail = require('@sendgrid/mail');
const fetch = require('node-fetch');

const app = express();

// ── Config (ALL from env vars) ──
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'angela@ebiresults.com';
const REPLY_TO = process.env.REPLY_TO || 'ebipartnersorg@gmail.com';
const CLOSE_API_KEY = process.env.CLOSE_API_KEY;
const RENEE_EMAIL = '14calder@gmail.com';

sgMail.setApiKey(SENDGRID_API_KEY);

app.use(cors());
app.use(express.json());

// ── Helper: Push lead to Close CRM ──
async function pushToClose({ name, email, phone, url, score, issues, scannedBy }) {
  if (!CLOSE_API_KEY) return null;

  const isReneeScan = scannedBy === 'renee' || (email && email.toLowerCase() === RENEE_EMAIL.toLowerCase());
  // Renee Scan → Nurture (testing), Self Scan → HOT LEAD (customer action)
  const statusType = isReneeScan ? 'Potential' : 'HOT LEAD';

  const body = {
    name: name || email?.split('@')[0] || 'Unknown Lead',
    contacts: [{
      name: name || email?.split('@')[0] || 'Unknown',
      emails: email ? [{ type: 'office', email }] : [],
      phones: phone ? [{ type: 'office', phone }] : []
    }],
    "custom.lf_cf_custom_website": url || '',
    "custom.lf_cf_custom_funnel_source": 'AI Readiness Funnel',
    "custom.lf_cf_custom_ai_readiness_score": String(score || 0),
    "custom.lf_cf_custom_issues_found": String(issues || 0),
    description: `Scan Type: ${isReneeScan ? 'Renee Scan' : 'Self Scan'}\nWebsite: ${url}\nScore: ${score}/100\nTag: ${isReneeScan ? 'Renee Scan → Nurture (testing)' : 'Self Scan → HOT LEAD'}`
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
    if (response.ok) console.log(`✅ Close: ${name} — ${isReneeScan ? 'Renee Scan → Nurture' : 'Self Scan → HOT LEAD'}`);
    else console.error('❌ Close error:', JSON.stringify(data).substring(0,200));
    return data;
  } catch (err) {
    console.error('❌ Close push failed:', err.message);
    return null;
  }
}

// ── API: Full Scan + Close Push ──
app.post('/api/scan', async (req, res) => {
  try {
    const { url, email, name, phone, scannedBy } = req.body;
    const cleanUrl = url?.replace(/\/$/, '');
    if (!cleanUrl) return res.status(400).json({ error: 'URL required' });

    const result = { score: 0, categories: {} };
    const issues = [];

    try {
      const pageRes = await fetch(cleanUrl, { timeout: 10000 });
      const html = await pageRes.text();
      const bodyText = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      const wordCount = bodyText.split(' ').length;
      const isWP = html.includes('wp-content') || html.includes('wp-json');

      result.categories.platform = { status: isWP ? 'good' : 'info', label: isWP ? 'WordPress' : 'Not WordPress' };

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
      const hasSchema = html.includes('application/ld+json') || html.includes('itemscope') || html.includes('schema.org');
      if (hasSchema) result.categories.schema = { status: 'good', label: 'Schema found' };
      else { result.categories.schema = { status: 'bad', label: 'No schema markup', points: 20 }; issues.push('No schema markup'); }

      // Content
      if (wordCount > 800) result.categories.content = { status: 'good', label: `${wordCount} words` };
      else if (wordCount > 300) result.categories.content = { status: 'warn', label: `${wordCount} words`, points: 10 };
      else { result.categories.content = { status: 'bad', label: `${wordCount} words`, points: 15 }; issues.push(`Thin content (${wordCount} words)`); }

      // Crawlability
      try {
        const robotsRes = await fetch(cleanUrl + '/robots.txt', { timeout: 5000 });
        if (robotsRes.ok) {
          const robotsText = await robotsRes.text();
          const hasGpt = robotsText.toLowerCase().includes('gptbot') || robotsText.toLowerCase().includes('claudebot');
          result.categories.crawlability = hasGpt ? { status: 'good', label: 'AI crawlers allowed' } : { status: 'warn', label: 'AI crawlers not mentioned', points: 5 };
        } else {
          result.categories.crawlability = { status: 'warn', label: 'No robots.txt', points: 5 };
        }
      } catch(e) { result.categories.crawlability = { status: 'warn', label: 'No robots.txt', points: 5 }; }

      // FAQ
      if (html.toLowerCase().includes('faq')) result.categories.faq = { status: 'good', label: 'FAQ content found' };
      else { result.categories.faq = { status: 'bad', label: 'No FAQ content', points: 10 }; issues.push('No FAQ content'); }

      // H1
      const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      if (h1Match) result.categories.h1 = { status: 'good', label: `H1 found` };
      else { result.categories.h1 = { status: 'bad', label: 'Missing H1', points: 5 }; issues.push('Missing H1'); }

      // Sitemap
      try {
        const smRes = await fetch(cleanUrl + '/sitemap.xml', { timeout: 5000 });
        if (smRes.ok) result.categories.sitemap = { status: 'good', label: 'Sitemap found' };
        else { result.categories.sitemap = { status: 'bad', label: 'No sitemap.xml', points: 5 }; issues.push('No sitemap.xml'); }
      } catch(e) { result.categories.sitemap = { status: 'bad', label: 'No sitemap.xml', points: 5 }; issues.push('No sitemap.xml'); }

      // GBP
      if (html.includes('google.com/maps') || html.includes('LocalBusiness')) result.categories.gbp = { status: 'good', label: 'GBP referenced' };
      else result.categories.gbp = { status: 'warn', label: 'No GBP on page', points: 5 };

    } catch (err) {
      return res.status(502).json({ error: `Cannot reach ${cleanUrl}` });
    }

    const deductions = Object.values(result.categories).filter(c => c.points).reduce((sum, c) => sum + c.points, 0);
    result.score = Math.max(0, 100 - deductions);
    result.issues = issues;
    result.issueCount = issues.length;

    // Push to Close
    if (email || name || phone) {
      const scannedByValue = scannedBy || (email === RENEE_EMAIL ? 'renee' : 'self');
      await pushToClose({ name: name || email?.split('@')[0], email, phone, url: cleanUrl, score: result.score, issues: issues.length, scannedBy: scannedByValue });
    }

    res.json(result);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Lead capture (lightweight) ──
app.post('/api/lead', async (req, res) => {
  try {
    const { url, email, name, phone, scannedBy } = req.body;
    await pushToClose({ name: name || email?.split('@')[0], email, phone, url, score: 0, issues: 0, scannedBy: scannedBy || 'self' });
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

// ── API: Capture lead (from checkout page) ──
app.post('/api/capture-lead', async (req, res) => {
  try {
    const { name, email, phone, website, city, state, coupon } = req.body;
    // Send notification to Renée
    await sgMail.send({
      to: '14calder@gmail.com',
      from: { email: FROM_EMAIL, name: 'EBI Results Scanner' },
      replyTo: REPLY_TO,
      subject: `💰 New $7 Lead: ${name} — ${website || 'no website'}`,
      html: `<p><strong>Name:</strong> ${name}</p>
<p><strong>Email:</strong> ${email}</p>
<p><strong>Phone:</strong> ${phone || 'none'}</p>
<p><strong>Website:</strong> ${website || 'none'}</p>
<p><strong>City/State:</strong> ${city || ''} ${state || ''}</p>
<p><strong>Coupon:</strong> ${coupon || 'none'}</p>`
    });
    // Push to Close CRM
    await pushToClose({ name, email, phone, url: website, score: 0, issues: 0, scannedBy: 'self' });
    res.json({ success: true });
  } catch (err) {
    console.error('capture-lead error:', err.message);
    res.json({ success: false });
  }
});

// ── API: Create Stripe checkout session ──
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { amount, customerEmail, product, coupon } = req.body;
    // For now, redirect to the static checkout page
    // Real Stripe session creation requires the stripe npm package
    const finalAmount = amount || 700;
    
    // Send email notification to Renée
    await sgMail.send({
      to: '14calder@gmail.com',
      from: { email: FROM_EMAIL, name: 'EBI Results Scanner' },
      replyTo: REPLY_TO,
      subject: `🛒 Checkout initiated — $${(finalAmount/100).toFixed(2)} — ${customerEmail || 'no email'}`,
      html: `<p><strong>Amount:</strong> $${(finalAmount/100).toFixed(2)}</p>
<p><strong>Customer:</strong> ${customerEmail || 'unknown'}</p>
<p><strong>Product:</strong> ${product || 'ai-readiness'}</p>
<p><strong>Coupon:</strong> ${coupon || 'none'}</p>`
    });

    // For now, redirect to the scanner (in production, create a Stripe session)
    res.json({
      url: 'https://buy.stripe.com/5kQ8wP9Cw0yp9bt2BQ7Vm05'
    });
  } catch (err) {
    console.error('create-checkout error:', err.message);
    res.json({ error: err.message });
  }
});

// ── Export for Vercel ──
module.exports = app;
