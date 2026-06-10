/**
 * One-time Plaid Link setup server.
 *
 * Run:  bun run packages/plaid-tools/src/setup.ts
 *
 * Starts a local server on :3333, opens a browser page with Plaid Link,
 * walks through connecting a bank account, then prints the access_token
 * and instructions for adding it to your .env.
 *
 * Run once per bank (Chase, SoFi, etc). Each produces an access_token —
 * add them all to PLAID_ACCESS_TOKENS as a JSON array.
 */
import { makePlaidClient } from "./client.js"
import { Products, CountryCode } from "plaid"

const client = makePlaidClient()
const PORT = 3333

const HTML = (linkToken: string) => `<!DOCTYPE html>
<html>
<head>
  <title>Luna × Plaid Setup</title>
  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <style>
    body { font-family: system-ui; background: #06090f; color: #e2e8f0;
           display: flex; flex-direction: column; align-items: center;
           justify-content: center; height: 100vh; margin: 0; gap: 16px; }
    button { background: #8ab4f8; color: #06090f; border: none; border-radius: 12px;
             padding: 12px 28px; font-size: 16px; font-weight: 600; cursor: pointer; }
    button:hover { background: #c8dafc; }
    pre { background: rgba(138,180,248,0.1); border-radius: 8px; padding: 16px;
          font-size: 13px; color: #34d399; max-width: 600px; word-break: break-all; }
    #result { display: none; text-align: center; }
    #status { color: rgba(186,218,255,0.5); font-size: 14px; }
  </style>
</head>
<body>
  <img src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 110 110'><path d='M 62 12 A 38 38 0 1 0 88 62 A 30 30 0 1 1 62 12 Z' fill='rgba(186,218,255,0.5)'/></svg>" />
  <h2 style="margin:0">Luna × Plaid</h2>
  <p id="status">Connect your bank account so Jax can query your finances.</p>
  <button id="link-btn" onclick="openLink()">Connect Bank Account</button>

  <div id="result">
    <p style="color:#34d399">✓ Connected! Your access token:</p>
    <pre id="token-display"></pre>
    <p style="color:rgba(186,218,255,0.5);font-size:13px">
      Add this to your <code>.env</code> file as PLAID_ACCESS_TOKENS.<br>
      If you have multiple banks, it's a JSON array: <code>["token1","token2"]</code>
    </p>
    <p>You can close this window.</p>
  </div>

  <script>
    const linkToken = ${JSON.stringify(linkToken)};
    function openLink() {
      const handler = Plaid.create({
        token: linkToken,
        onSuccess: async (public_token, metadata) => {
          const resp = await fetch('/exchange', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ public_token })
          });
          const { access_token } = await resp.json();
          document.getElementById('link-btn').style.display = 'none';
          document.getElementById('status').style.display = 'none';
          document.getElementById('result').style.display = 'block';
          document.getElementById('token-display').textContent = access_token;
        },
        onExit: (err) => {
          if (err) document.getElementById('status').textContent = 'Error: ' + err.display_message;
        }
      });
      handler.open();
    }
  </script>
</body>
</html>`

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === "/" && req.method === "GET") {
      const resp = await client.linkTokenCreate({
        user: { client_user_id: "sterling" },
        client_name: "Luna",
        products: [Products.Transactions],
        country_codes: [CountryCode.Us],
        language: "en",
      })
      return new Response(HTML(resp.data.link_token), {
        headers: { "Content-Type": "text/html" },
      })
    }

    if (url.pathname === "/exchange" && req.method === "POST") {
      const { public_token } = (await req.json()) as { public_token: string }
      const exchangeResp = await client.itemPublicTokenExchange({ public_token })
      const access_token = exchangeResp.data.access_token

      console.log("\n✅ Access token received:")
      console.log(`   ${access_token}`)
      console.log(
        "\nAdd to your .env:\n   PLAID_ACCESS_TOKENS=[\"" + access_token + "\"]",
      )
      console.log("\nThen restart the Luna chat server.")

      return Response.json({ access_token })
    }

    return new Response("Not found", { status: 404 })
  },
})

console.log(`\n🌙 Luna × Plaid Setup`)
console.log(`   Server running at http://localhost:${PORT}`)
console.log(`   Opening browser...\n`)

// Open browser automatically
Bun.spawn(["open", `http://localhost:${PORT}`])

console.log("Waiting for bank connection... (Ctrl+C to cancel)\n")
