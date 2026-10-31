// POST   /api/session  { token }  -> grava o access token do Google num cookie HttpOnly (usado só por /api/stream)
// DELETE /api/session             -> apaga o cookie
'use strict';

// Access tokens do Google usam apenas estes caracteres. Rejeitar o resto evita injeção de atributos no cookie.
const TOKEN_RE = /^[A-Za-z0-9._~+\/-]{20,2048}$/;

module.exports = async function handler(req, res) {
  // Mesma origem: não há CORS aqui de propósito. Refletir a origem com credenciais permitiria
  // que qualquer site lesse seus filmes usando o seu cookie.
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', 'cine_token=; Path=/api; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    return res.status(204).end();
  }

  if (req.method === 'POST') {
    const token = req.body && req.body.token;
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
      return res.status(400).send('Token inválido');
    }
    res.setHeader('Set-Cookie', `cine_token=${token}; Path=/api; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`);
    return res.status(204).end();
  }

  res.setHeader('Allow', 'POST, DELETE');
  return res.status(405).send('Método não permitido');
};
