// POST   /api/session  { token }  -> grava o access token do Google num cookie HttpOnly (usado só por /api/stream)
// DELETE /api/session             -> apaga o cookie
//
// Cloudflare Pages Functions (runtime Workers). Sem dependências.

// Access tokens do Google usam apenas estes caracteres. Rejeitar o resto evita injeção de atributos no cookie.
const TOKEN_RE = /^[A-Za-z0-9._~+\/-]{20,2048}$/;

const reply = (status, body = null, extra = {}) =>
  new Response(body, { status, headers: { 'Cache-Control': 'no-store', ...extra } });

export async function onRequest({ request }) {
  // Mesma origem: não há CORS aqui de propósito. Refletir a origem com credenciais permitiria
  // que qualquer site lesse seus filmes usando o seu cookie.
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return reply(403, 'Origem não permitida');

  if (request.method === 'DELETE') {
    return reply(204, null, { 'Set-Cookie': 'cine_token=; Path=/api; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
  }

  if (request.method === 'POST') {
    const body = await request.json().catch(() => null);
    const token = body && body.token;
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return reply(400, 'Token inválido');
    return reply(204, null, { 'Set-Cookie': `cine_token=${token}; Path=/api; HttpOnly; Secure; SameSite=Lax; Max-Age=3600` });
  }

  return reply(405, 'Método não permitido', { Allow: 'POST, DELETE' });
}
