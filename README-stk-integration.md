# M-Pesa (Daraja) Integration for Dees Jewelry

This repository adds a minimal Node.js/Express backend to initiate Lipa Na M-Pesa (STK Push) requests using Safaricom's Daraja API and to receive payment callbacks.

Important: This code is an example. Do NOT run in production without reviewing security, error handling, and production configuration.

Files added
- server/index.js — Express app that implements /api/stkpush and /api/mpesa/callback
- server/package.json
- .env.example
- data/transactions.json (created at runtime)

Setup (local testing)
1. Copy `.env.example` to `.env` and fill values.
2. npm install
3. npm start
4. Expose your local server using ngrok (e.g. `ngrok http 3000`) and use the forwarding URL as CALLBACK_BASE_URL in your .env when testing with Daraja sandbox.

Basic flow
- Frontend POSTs to /api/stkpush with amount and phone.
- Server requests an access token from Daraja, then calls the STK Push endpoint.
- Daraja sends a callback to /api/mpesa/callback — this endpoint saves the raw callback to data/transactions.json.

Next steps you should take
- Fill env vars with your Daraja sandbox credentials first.
- Implement server-side order persistence and verification. Only mark orders paid after successful callback and, if necessary, cross-check transaction IDs with Daraja.
- Add authentication, rate limiting, and input validation before deploying.
