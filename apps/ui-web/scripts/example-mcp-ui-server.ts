/**
 * example-mcp-ui-server.ts — a small, REAL external MCP server that serves an
 * MCP Apps (SEP-1865) UI, used to prove Luna's G4 external-server relay end to
 * end. It is deliberately "third-party": it lives behind the MCP wire (stdio or
 * in-memory), uses its OWN `ui://example/*` namespace, and its app HTML contains
 * ZERO Luna-specific or theme code — only `var(--color-*)`. When Luna renders it
 * through the relay, the G1.5 cage shim applies Luna's palette automatically.
 *
 * Two entry modes:
 *   - `createExampleServer()` — returns an unconnected McpServer (tests link it
 *     to a Client via InMemoryTransport).
 *   - run directly (`bun run example-mcp-ui-server.ts`) — connects over stdio so
 *     it is a genuine separate process for the live demo / screenshot.
 *
 * Built on the official `@modelcontextprotocol/sdk` (the library chosen for the
 * relay): spec-correct resources/list + resources/read + tools/list + tools/call.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

/** This server's single UI resource — its OWN namespace, not `ui://luna/*`. */
export const EXAMPLE_APP_URI = "ui://example/dashboard"
export const EXAMPLE_APP_MIME = "text/html;profile=mcp-app"
export const EXAMPLE_TOOL = "example-stats"

/** The app the external server ships. NO theme code, NO Luna bridge — only
 *  var(--color-*) (themed by Luna's G1.5 cage shim) + raw MCP Apps JSON-RPC to
 *  whatever host renders it (Luna, Claude Desktop, …). It pulls its data by
 *  calling its OWN server's `example-stats` tool through the host relay. */
const APP_HTML = `<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%;background:var(--color-background-primary,#0a0e1c);color:var(--color-text-primary,#e2ecfd);font-family:var(--font-sans,system-ui,sans-serif);font-size:13px}
  .wrap{height:100%;display:flex;flex-direction:column;gap:10px;padding:16px}
  .badge{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--color-text-tertiary,#64748b)}
  .title{font-size:13px;font-weight:700;color:var(--color-ring-primary,#8ab4f8)}
  .row{display:flex;gap:10px}
  .card{flex:1;background:var(--color-background-secondary,rgba(255,255,255,.05));border:1px solid var(--color-border-primary,rgba(255,255,255,.12));border-radius:var(--border-radius-md,10px);padding:12px}
  .k{font-size:10px;text-transform:uppercase;letter-spacing:.03em;color:var(--color-text-tertiary,#64748b)}
  .v{font-size:22px;font-weight:700;margin-top:4px;font-family:var(--font-mono,ui-monospace,monospace)}
  .focus{margin-top:auto;font-size:11px;color:var(--color-text-secondary,#94a3b8)}
  .focus b{color:var(--color-text-primary,#e2ecfd)}
</style>
<div class="wrap">
  <div class="badge">external mcp server · ui://example/dashboard</div>
  <div class="title">Example Server</div>
  <div class="row">
    <div class="card"><div class="k">Open tasks</div><div class="v" id="open">–</div></div>
    <div class="card"><div class="k">Due today</div><div class="v" id="due">–</div></div>
  </div>
  <div class="focus">Focus: <b id="focus">…</b></div>
</div>
<script>
(function(){
  var nextId=1, pending={};
  function post(m){ window.parent.postMessage(m,'*'); }
  function request(method,params){ return new Promise(function(res,rej){ var id=nextId++; pending[id]={res:res,rej:rej}; post({jsonrpc:'2.0',id:id,method:method,params:params||{}}); }); }
  window.addEventListener('message',function(e){
    if(e.source!==window.parent) return;
    var m=e.data; if(!m||m.jsonrpc!=='2.0') return;
    if(m.id!=null&&pending[m.id]){ var p=pending[m.id]; delete pending[m.id]; if('error' in m) p.rej(m.error); else p.res(m.result); }
  });
  function render(s){ if(!s) return; document.getElementById('open').textContent=String(s.openTasks); document.getElementById('due').textContent=String(s.dueToday); document.getElementById('focus').textContent=String(s.focus); }
  request('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:'example-dashboard',version:'1.0.0'}})
    .then(function(){
      post({jsonrpc:'2.0',method:'ui/notifications/initialized'});
      return request('tools/call',{name:'${EXAMPLE_TOOL}',arguments:{}});
    })
    .then(function(r){ render(r&&r.structuredContent?r.structuredContent:r); })
    .catch(function(){});
})();
</script>`

const EXAMPLE_STATS = { openTasks: 7, dueToday: 2, focus: "Ship G4" }

/** Build the example server with its UI resource + data tool registered. */
export const createExampleServer = (): McpServer => {
  const server = new McpServer({ name: "example-mcp-ui-server", version: "1.0.0" })

  server.registerResource(
    "dashboard",
    EXAMPLE_APP_URI,
    {
      title: "Example Dashboard",
      description: "A third-party MCP app rendered as a Luna panel.",
      mimeType: EXAMPLE_APP_MIME,
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: EXAMPLE_APP_MIME, text: APP_HTML }],
    }),
  )

  server.registerTool(
    EXAMPLE_TOOL,
    {
      description: "Current example workspace stats.",
      // Spec tool→UI linkage: this tool backs the dashboard app.
      _meta: { ui: { resourceUri: EXAMPLE_APP_URI, visibility: ["model", "app"] } },
    },
    () => ({
      content: [{ type: "text", text: JSON.stringify(EXAMPLE_STATS) }],
      structuredContent: EXAMPLE_STATS,
    }),
  )

  return server
}

// Run as a real stdio process for the live demo (Bun sets import.meta.main).
if ((import.meta as unknown as { main?: boolean }).main) {
  const server = createExampleServer()
  await server.connect(new StdioServerTransport())
}
