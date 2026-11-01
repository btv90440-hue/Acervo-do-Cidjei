# Acervo do Cidjei

Biblioteca e player de filmes armazenados localmente ou no Google Drive.
Hospedado como **Cloudflare Worker com arquivos estáticos** (plano gratuito).

## Estrutura

```
wrangler.jsonc               <- configuração (nome do Worker, pasta public/, rota /api/*)
src/
  worker.js                  <- roteador: só /api/* executa código
  api/session.js             <- POST/DELETE /api/session
  api/stream.js              <- GET /api/stream/:id  (ponte de streaming do Drive, com Range)
  api/auth.js                <- /api/auth/{status,login,callback,refresh,folders,logout}
public/                      <- tudo que o site serve
  index.html
  manifest.webmanifest
  sw.js                      <- só remove o service worker antigo dos aparelhos
  _headers                   <- cabeçalhos de segurança e cache
  .well-known/assetlinks.json
  icons/                     <- seus ícones (icon-192.png, icon-512.png, icon-maskable-512.png)
```

## Publicar (Workers Builds, ligado ao GitHub)

1. Suba esta pasta para o repositório (a pasta `icons/` do projeto antigo vai para dentro de `public/`).
   Apague do repositório os arquivos antigos da raiz (`index.html`, `api/`, `vercel.json` etc.)
   e qualquer `wrangler.toml` antigo, para existir só o `wrangler.jsonc` deste projeto.
2. No painel: **Workers & Pages → seu Worker → Settings → Build**:
   - **Build command:** vazio
   - **Deploy command:** `npx wrangler deploy`
   - **Root directory:** `/`
3. Em **Settings → Variables and Secrets**, crie como **Secret**:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `COOKIE_SECRET` — um texto aleatório longo (ex.: `openssl rand -base64 48`)
4. Faça um novo deploy (um commit novo, ou **Deployments → Retry build**).

O nome em `wrangler.jsonc` (`acervo-do-cidjei`) precisa ser igual ao nome do Worker no painel.

### Alternativa pela linha de comando

```bash
npx wrangler deploy
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put COOKIE_SECRET
```

## Google Cloud (obrigatório ao trocar de domínio)

No [Google Cloud Console](https://console.cloud.google.com/apis/credentials), no seu *OAuth client ID* da web, adicione:

- **Origens JavaScript autorizadas:** `https://acervo-do-cidjei.btv90440.workers.dev`
- **URIs de redirecionamento autorizados:**
  - `https://acervo-do-cidjei.btv90440.workers.dev/`
  - `https://acervo-do-cidjei.btv90440.workers.dev/api/auth/callback`

Mantenha a **Google Drive API** ativada. Se usar domínio próprio, adicione também as URLs dele.

## Conferir se funcionou

- `https://acervo-do-cidjei.btv90440.workers.dev/api/auth/status` deve mostrar `{"configured":true}`.
- Ao abrir "Google Drive" no site, o campo "ID de cliente OAuth" não deve aparecer.

## APK (TWA)

O APK abre um endereço fixo, então **precisa ser gerado de novo** apontando para o novo domínio
(PWABuilder ou Bubblewrap). Para não precisar mexer em `assetlinks.json`, mantenha o mesmo
`package_name` e a **mesma chave de assinatura** (keystore) do APK atual. Depois do deploy, confira:

```bash
curl -i https://acervo-do-cidjei.btv90440.workers.dev/.well-known/assetlinks.json
```

Deve responder `200` com o JSON do arquivo.

## Testar localmente

```bash
cp .dev.vars.example .dev.vars   # preencha com os mesmos valores
npx wrangler dev
```

Para o login Google funcionar localmente, adicione `http://localhost:8787` e
`http://localhost:8787/api/auth/callback` no Google Cloud.

## Limites do plano gratuito

- Arquivos estáticos (site, ícones, manifest): ilimitados.
- Código (`/api/*`): 100.000 chamadas por dia, 10 ms de CPU por chamada. O streaming só repassa
  o corpo do Drive (não gasta CPU), mas cada "pulo" no vídeo faz uma nova chamada.

## Licença

Veja `LICENSE`.
