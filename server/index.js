// Express server with static hosting, improved validation, phone normalization and better logging
// Usage: copy .env.example to .env and fill values, then `npm install` and `npm start`.

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const CONSUMER_KEY = process.env.CONSUMER_KEY || '';
const CONSUMER_SECRET = process.env.CONSUMER_SECRET || '';
const SHORTCODE = process.env.SHORTCODE || '';
const PASSKEY = process.env.PASSKEY || '';
const CALLBACK_BASE = process.env.CALLBACK_BASE_URL || ''; // public base URL for callbacks
const DAR_AJA_BASE = process.env.DARAJA_BASE_URL || 'https://sandbox.safaricom.co.ke';

if (!CONSUMER_KEY || !CONSUMER_SECRET || !SHORTCODE || !PASSKEY || !CALLBACK_BASE) {
  console.warn('Warning: Some required environment variables are not set. See .env.example');
}

// Serve static site (purchase.html and assets) from repo root so frontend and backend share origin
const STATIC_DIR = path.join(__dirname, '..');
app.use(express.static(STATIC_DIR));

// Simple token cache
let tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt > now) return tokenCache.token;

  try {
    const url = `${DAR_AJA_BASE}/oauth/v1/generate?grant_type=client_credentials`;
    const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');

    const res = await axios.get(url, {
      headers: { Authorization: `Basic ${auth}` },
      timeout: 10000
    });

    const token = res.data.access_token;
    tokenCache = { token, expiresAt: now + 50 * 60 * 1000 };
    return token;
  } catch (err) {
    console.error('Failed to get Daraja access token:', err.response ? err.response.data : err.message);
    throw err;
  }
}

function timestamp() {
  const d = new Date();
  const yyyy = d.getFullYear().toString();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}${hh}${min}${ss}`;
}

function stkPassword(shortcode, passkey, ts) {
  const p = `${shortcode}${passkey}${ts}`;
  return Buffer.from(p).toString('base64');
}

// Ensure data dir
const DATA_DIR = path.join(__dirname, '..', 'data');
const TX_FILE = path.join(DATA_DIR, 'transactions.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(TX_FILE)) fs.writeFileSync(TX_FILE, JSON.stringify({}), 'utf8');

function saveTransaction(orderId, obj) {
  try {
    const store = JSON.parse(fs.readFileSync(TX_FILE, 'utf8') || '{}');
    store[orderId] = store[orderId] || [];
    store[orderId].push(obj);
    fs.writeFileSync(TX_FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    console.error('Failed to save transaction', err);
  }
}

function normalizeKenyanPhone(input) {
  // Accept formats: 07XXXXXXXX, 2547XXXXXXXX, +2547XXXXXXXX
  if (!input) return '';
  let s = input.trim();
  s = s.replace(/[^0-9+]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('0')) s = '254' + s.slice(1);
  if (s.startsWith('7')) s = '254' + s;
  return s; // e.g., 2547XXXXXXXX
}

// Diagnostic endpoint: attempt to fetch Daraja access token and return masked token or error details
app.get('/api/token', async (req, res) => {
  try {
    if (!CONSUMER_KEY || !CONSUMER_SECRET) {
      return res.status(500).json({ ok: false, error: 'Missing CONSUMER_KEY or CONSUMER_SECRET in environment' });
    }
    const token = await getAccessToken();
    const masked = token ? `***${token.slice(-6)}` : null;
    res.json({ ok: true, token: masked, expiresIn: tokenCache.expiresAt ? Math.max(0, tokenCache.expiresAt - Date.now()) : null });
  } catch (err) {
    const details = err.response && err.response.data ? err.response.data : { message: err.message };
    res.status(500).json({ ok: false, error: 'Failed to get token', details });
  }
});

app.post('/api/stkpush', async (req, res) => {
  // expected: { amount, phone, orderId, accountReference, description }
  const { amount, phone, orderId, accountReference, description } = req.body;
  if (!amount || !phone) return res.status(400).json({ error: 'amount and phone are required' });

  const normalizedPhone = normalizeKenyanPhone(phone);
  if (!/^2547\d{8}$/.test(normalizedPhone)) {
    return res.status(400).json({ error: 'phone must be a Kenyan mobile number, e.g. 07XXXXXXXX or 2547XXXXXXXX' });
  }

  if (!CONSUMER_KEY || !CONSUMER_SECRET || !SHORTCODE || !PASSKEY || !CALLBACK_BASE) {
    return res.status(500).json({ error: 'Server not configured with Daraja credentials. Check environment variables.' });
  }

  try {
    const token = await getAccessToken();
    const ts = timestamp();
    const password = stkPassword(SHORTCODE, PASSKEY, ts);

    const body = {
      BusinessShortCode: SHORTCODE,
      Password: password,
      Timestamp: ts,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: normalizedPhone, // customer phone number in format 2547XXXXXXXX
      PartyB: SHORTCODE,
      PhoneNumber: normalizedPhone,
      CallBackURL: `${CALLBACK_BASE.replace(/\/$/, '')}/api/mpesa/callback`,
      AccountReference: accountReference || (orderId || 'ORDER'),
      TransactionDesc: description || 'Payment for order'
    };

    const url = `${DAR_AJA_BASE}/mpesa/stkpush/v1/processrequest`;
    const resp = await axios.post(url, body, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000
    });

    // store request
    saveTransaction(orderId || ('req-' + Date.now()), { type: 'stk_request', request: body, response: resp.data, ts: new Date().toISOString() });

    console.log('STK Push requested:', (resp.data && resp.data.ResponseDescription) || resp.data);
    res.json({ ok: true, data: resp.data });
  } catch (err) {
    console.error('STK Push error', err.response ? err.response.data : err.message);
    const details = err.response && err.response.data ? err.response.data : { message: err.message };
    // persist error
    saveTransaction(orderId || ('err-' + Date.now()), { type: 'stk_error', details, ts: new Date().toISOString() });
    res.status(500).json({ error: 'STK Push failed', details });
  }
});

// Callback endpoint Daraja will POST to
app.post('/api/mpesa/callback', (req, res) => {
  try {
    const body = req.body;
    // Daraja sends a nested JSON structure. Save raw body for inspection.
    const orderId = (body && body.Body && body.Body.stkCallback && body.Body.stkCallback.CheckoutRequestID) || `cb-${Date.now()}`;
    saveTransaction(orderId, { type: 'callback', body, ts: new Date().toISOString() });

    // respond immediately 200 OK (Daraja expects HTTP 200)
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (err) {
    console.error('callback error', err);
    res.status(500).end();
  }
});

app.get('/api/order/:id/status', (req, res) => {
  const id = req.params.id;
  const store = JSON.parse(fs.readFileSync(TX_FILE, 'utf8') || '{}');
  res.json({ id, entries: store[id] || [] });
});

// Health
app.get('/api/health', (req, res) => res.json({ ok: true, darajaBase: DAR_AJA_BASE }));

app.listen(PORT, () => {
  console.log(`M-Pesa backend listening on port ${PORT}`);
  console.log(`Daraja base URL: ${DAR_AJA_BASE}`);
  console.log(`Serving static from ${STATIC_DIR}`);
});
