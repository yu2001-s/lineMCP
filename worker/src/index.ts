/**
 * Public front door for the LINE MCP server.
 *
 * - OAuth 2.1 for MCP clients (Claude registers itself via DCR). The only
 *   identity is the owner, who proves it by entering OWNER_PASSPHRASE on the
 *   consent page.
 * - Authorized /mcp requests are proxied to the home server through a
 *   Workers VPC service (Cloudflare Tunnel), so the server has no public
 *   hostname and listens on 127.0.0.1 only.
 */
import {
	AuthorizationError,
	type ConsentDescription,
	type OAuthHelpers,
	OAuthProvider,
} from "@cloudflare/workers-oauth-provider";

interface Env {
	OAUTH_KV: KVNamespace;
	OAUTH_PROVIDER: OAuthHelpers;
	LINE_BACKEND: Fetcher;
	/** Shared secret the backend checks in x-line-mcp-key. */
	BACKEND_KEY: string;
	/** SHA-256 hex digest of the owner passphrase. */
	OWNER_PASSPHRASE_SHA256: string;
}

const BACKEND_URL = "http://127.0.0.1:8790/mcp";
const BACKEND_ORIGIN = "http://127.0.0.1:8790";
// An agent's line_create_upload URL. The id is a one-time secret the backend
// handed out over authorized MCP, so the URL needs no OAuth token: curl -T works.
const UPLOAD_PATH = /^\/upload\/[A-Za-z0-9_-]{32}$/;
const MAX_FAILED_LOGINS_PER_HOUR = 10;
// Headers an MCP client legitimately sends; everything else (notably the
// OAuth bearer token) stays at the edge.
const FORWARDED_HEADERS = ["content-type", "accept", "mcp-protocol-version"];

const mcpProxy = {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
		}
		const headers = new Headers({ "x-line-mcp-key": env.BACKEND_KEY });
		for (const name of FORWARDED_HEADERS) {
			const value = request.headers.get(name);
			if (value) headers.set(name, value);
		}
		let upstream: Response;
		try {
			upstream = await env.LINE_BACKEND.fetch(BACKEND_URL, {
				method: "POST",
				headers,
				body: request.body,
			});
		} catch (e) {
			console.error("backend unreachable", e);
			return Response.json(
				{
					jsonrpc: "2.0",
					id: null,
					error: { code: -32000, message: "The LINE server at home is unreachable (is the server online?)." },
				},
				{ status: 502 },
			);
		}
		return new Response(upstream.body, {
			status: upstream.status,
			headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
		});
	},
};

const authHandler = {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/") {
			return new Response("LINE MCP gateway. Add /mcp as a custom connector in Claude.", {
				headers: { "content-type": "text/plain; charset=utf-8" },
			});
		}
		if (UPLOAD_PATH.test(url.pathname)) return uploadProxy(request, env, url.pathname);
		if (url.pathname !== "/authorize") return new Response("Not Found", { status: 404 });

		const oauth = env.OAUTH_PROVIDER;
		try {
			if (request.method === "GET") {
				const authRequest = await oauth.parseAuthRequest(request);
				const details = await oauth.describeConsent(authRequest);
				const consent = await oauth.beginConsent(authRequest);
				return page(consentPage(details, consent.handle), consent.headers);
			}
			if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

			const form = await request.formData();
			const handle = String(form.get("handle") ?? "");
			if (form.get("decision") !== "approve") {
				const denied = await oauth.denyConsent(request, handle);
				return new Response(null, { status: 302, headers: denied.headers });
			}
			if (await tooManyFailures(env)) {
				return page(errorPage("Too many wrong passphrases. Try again in an hour."), undefined, 429);
			}
			if (!(await passphraseMatches(String(form.get("passphrase") ?? ""), env))) {
				await recordFailure(env);
				return page(errorPage("Wrong passphrase. Go back to Claude and start connecting again."), undefined, 403);
			}
			const approved = await oauth.approveConsent(request, handle);
			const { redirectTo } = await oauth.completeAuthorization({
				request: approved.request,
				userId: "owner",
				metadata: {},
				scope: approved.request.scope,
				props: { userId: "owner" },
			});
			approved.headers.set("Location", redirectTo);
			return new Response(null, { status: 302, headers: approved.headers });
		} catch (error) {
			if (error instanceof AuthorizationError && error.redirectTo) {
				return Response.redirect(error.redirectTo, 302);
			}
			if (error instanceof AuthorizationError) {
				return page(errorPage(error.description), undefined, 400);
			}
			throw error;
		}
	},
};

export default new OAuthProvider<Env>({
	apiRoute: "/mcp",
	apiHandler: mcpProxy,
	defaultHandler: authHandler,
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
	// Re-entering the passphrase every 30 days of inactivity is the cost of
	// limiting how long a leaked refresh token stays useful.
	refreshTokenIdleTTL: 30 * 24 * 3600,
	resourceMetadata: {
		// This Worker's public URL.
		resource: "https://line-mcp.your-subdomain.workers.dev/mcp",
		resource_name: "LINE (personal account)",
	},
});

/** Streams a file PUT to an upload URL through to the backend, which checks the id. */
async function uploadProxy(request: Request, env: Env, path: string): Promise<Response> {
	if (request.method !== "PUT") {
		return Response.json({ error: "PUT the file's bytes, e.g. curl -T <path> '<url>'" }, { status: 405, headers: { Allow: "PUT" } });
	}
	let upstream: Response;
	try {
		upstream = await env.LINE_BACKEND.fetch(`${BACKEND_ORIGIN}${path}`, {
			method: "PUT",
			headers: { "x-line-mcp-key": env.BACKEND_KEY },
			body: request.body,
		});
	} catch (e) {
		console.error("backend unreachable", e);
		return Response.json({ error: "The LINE server at home is unreachable (is the server online?)." }, { status: 502 });
	}
	return new Response(upstream.body, {
		status: upstream.status,
		headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
	});
}

async function passphraseMatches(given: string, env: Env): Promise<boolean> {
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(given)),
	);
	const expected = hexToBytes(env.OWNER_PASSPHRASE_SHA256);
	return digest.length === expected.length &&
		crypto.subtle.timingSafeEqual(digest, expected);
}

// A global counter is enough: there is exactly one legitimate user.
function failureKey() {
	return `owner-login-failures:${Math.floor(Date.now() / 3_600_000)}`;
}

async function tooManyFailures(env: Env): Promise<boolean> {
	return Number(await env.OAUTH_KV.get(failureKey())) >= MAX_FAILED_LOGINS_PER_HOUR;
}

async function recordFailure(env: Env) {
	const key = failureKey();
	const count = Number(await env.OAUTH_KV.get(key)) + 1;
	await env.OAUTH_KV.put(key, String(count), { expirationTtl: 7200 });
}

function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return bytes;
}

const escape = (value: string) =>
	value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function consentPage(details: ConsentDescription, handle: string): string {
	const name = escape(details.clientName);
	return layout(
		`Allow ${name} to use your LINE?`,
		`<h1>Allow <span class="hl">${name}</span> to use your LINE?</h1>
<p>It will be able to read your chats and send messages as you.</p>
<p class="meta">Access goes to <strong>${escape(details.redirectHost)}</strong>.
${details.clientDomain ? `Published by <strong>${escape(details.clientDomain)}</strong>.` : "This app registered itself; its name is not verified."}</p>
${details.redirectIsLoopback ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>' : ""}
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <label for="passphrase">Owner passphrase</label>
  <input id="passphrase" name="passphrase" type="password" autocomplete="current-password" required autofocus>
  <div class="actions">
    <button name="decision" value="approve" class="primary">Allow</button>
    <button name="decision" value="deny" formnovalidate>Deny</button>
  </div>
</form>`,
	);
}

function errorPage(message: string): string {
	return layout("LINE MCP", `<h1>Not connected</h1><p>${escape(message)}</p>`);
}

function layout(title: string, body: string): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root { --bg:#f6f7f8; --card:#fff; --fg:#16181c; --muted:#5b6270; --accent:#06c755; --line:#d9dde3; --warn:#9a3412; }
@media (prefers-color-scheme: dark) { :root { --bg:#111315; --card:#1b1e22; --fg:#eceef1; --muted:#9aa3ae; --line:#2e333a; --warn:#fdba74; } }
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, -apple-system, sans-serif; padding:16px; }
main { width:100%; max-width:420px; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:28px; }
h1 { font-size:1.25rem; margin:0 0 12px; }
.hl { color:var(--accent); }
.meta { color:var(--muted); font-size:.9rem; }
.warn { color:var(--warn); font-size:.9rem; }
label { display:block; font-weight:600; margin:20px 0 6px; }
input[type=password] { width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:transparent; color:inherit; font-size:1rem; }
.actions { display:flex; gap:10px; margin-top:18px; }
button { flex:1; padding:10px; border-radius:8px; border:1px solid var(--line); background:transparent; color:inherit; font-size:1rem; cursor:pointer; }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; }
</style></head>
<body><main>${body}</main></body></html>`;
}

function page(html: string, headers?: Headers, status = 200): Response {
	const h = headers ?? new Headers();
	h.set("content-type", "text/html; charset=utf-8");
	h.set("x-frame-options", "DENY");
	h.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
	return new Response(html, { status, headers: h });
}
