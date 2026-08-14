// Simple Express server to initiate M-Pesa STK Push (Daraja) and receive callbacks
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

// Simple token cache
let tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt > now) return tokenCache.token;

  const url = `${DAR_AJA_BASE}/oauth/v1/generate?grant_type=client_credentials`;
  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');

  const res = await axios.get(url, {
    headers: { Authorization: `Basic ${auth}` }
  });

  const token = res.data.access_token;
  // Daraja tokens generally last for some minutes; cache for 50 minutes as a safe default
  tokenCache = { token, expiresAt: now + 50 * 60 * 1000 };
  return token;
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
  const store = JSON.parse(fs.readFileSync(TX_FILE, 'utf8') || '{}');
  store[orderId] = store[orderId] || [];
  store[orderId].push(obj);
  fs.writeFileSync(TX_FILE, JSON.stringify(store, null, 2));
}

app.post('/api/stkpush', async (req, res) => {
  // expected: { amount, phone, orderId, accountReference, description }
  const { amount, phone, orderId, accountReference, description } = req.body;
  if (!amount || !phone) return res.status(400).json({ error: 'amount and phone are required' });

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
      PartyA: phone, // customer phone number in format 2547XXXXXXXX
      PartyB: SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: `${CALLBACK_BASE.replace(/\/$/, '')}/api/mpesa/callback`,
      AccountReference: accountReference || (orderId || 'ORDER'),
      TransactionDesc: description || 'Payment for order'
    };

    const url = `${DAR_AJA_BASE}/mpesa/stkpush/v1/processrequest`;
    const resp = await axios.post(url, body, {
      headers: { Authorization: `Bearer ${token}` }
    });

    // store request
    saveTransaction(orderId || ('req-' + Date.now()), { type: 'stk_request', request: body, response: resp.data, ts: new Date().toISOString() });

    res.json({ ok: true, data: resp.data });
  } catch (err) {
    console.error('STK Push error', err.response ? err.response.data : err.message);
    res.status(500).json({ error: 'STK Push failed', details: err.response ? err.response.data : err.message });
  }
});

// Callback endpoint Daraja will POST to
app.post('/api/mpesa/callback', (req, res) => {
  try {
    const body = req.body;
    // Daraja sends a nested JSON structure. Save raw body for inspection.
    const orderId = (body && body.Body && body.Body.stkCallback && body.Body.stkCallback.CheckoutRequestID) || `cb-${Date.now()}`;
    saveTransaction(orderId, { type: 'callback', body, ts: new Date().toISOString() });

    // respond immediately 200 OK
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

app.listen(PORT, () => {
  console.log(`M-Pesa backend listening on port ${PORT}`);
  console.log(`Daraja base URL: ${DAR_AJA_BASE}`);
});
