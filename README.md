# Acervo do Cidjei

Biblioteca e player de filmes armazenados localmente ou no Google Drive.
Hospedado no **Cloudflare Pages** (plano gratuito).

## Estrutura

```
public/                      <- tudo que o site serve (diretório de saída)
  index.html
  manifest.webmanifest
  sw.js                      <- só remove o service worker antigo dos aparelhos
  _headers                   <- cabeçalhos de segurança e cache
  _routes.json               <- só /api/* executa código (estáticos não gastam cota)
  .well-known/assetlinks.json
  icons/                     <- seus ícones (icon-192.png, icon-512.png, icon-maskable-512.png)
functions/api/               <- Cloudflare Pages Functions
  session.js                 <- POST/DELETE /api/session
  stream/[id].js             <- GET /api/stream/:id  (ponte de streaming do Drive, com Range)
  auth/[action].js           <- /api/auth/{status,login,callback,refresh,folders,logout}
```

## Publicar (uma vez)

1. Coloque esta pasta num repositório do GitHub (a pasta `icons/` do projeto antigo vai para dentro de `public/`).
2. No painel do Cloudflare: **Workers & Pages → Create → Pages → Connect to Git** e escolha o repositório.
3. Configuração de build:
   - Framework preset: **None**
   - Build command: *(vazio)*
   - Build output directory: **`public`**
4. Em **Settings → Variables and Secrets**, crie como **Secret** (em Production):
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `COOKIE_SECRET` — um texto aleatório longo (ex.: `openssl rand -base64 48`)
5. Faça um novo deploy (**Deployments → Retry deployment**) para os segredos valerem.

O site fica em `https://NOME-DO-PROJETO.pages.dev`.

### Alternativa pela linha de comando

```bash
npx wrangler pages deploy public --project-name acervo-do-cidjei
npx wrangler pages secret put GOOGLE_CLIENT_ID     --project-name acervo-do-cidjei
npx wrangler pages secret put GOOGLE_CLIENT_SECRET --project-name acervo-do-cidjei
npx wrangler pages secret put COOKIE_SECRET        --project-name acervo-do-cidjei
```

## Google Cloud (obrigatório ao trocar de domínio)

No [Google Cloud Console](https://console.cloud.google.com/apis/credentials), no seu *OAuth client ID* da web, adicione:

- **Origens JavaScript autorizadas:** `https://NOME-DO-PROJETO.pages.dev`
- **URIs de redirecionamento autorizados:**
  - `https://NOME-DO-PROJETO.pages.dev/`
  - `https://NOME-DO-PROJETO.pages.dev/api/auth/callback`

Mantenha a **Google Drive API** ativada. Se usar domínio próprio, adicione também as URLs dele.

## APK (TWA)

O APK abre um endereço fixo, então **precisa ser gerado de novo** apontando para o novo domínio
(PWABuilder ou Bubblewrap). Para não precisar mexer em `assetlinks.json`, mantenha o mesmo
`package_name` e a **mesma chave de assinatura** (keystore) do APK atual. Depois do deploy, confira:

```bash
curl -i https://NOME-DO-PROJETO.pages.dev/.well-known/assetlinks.json
```

Deve responder `200` com o JSON do arquivo.

## Testar localmente

```bash
cp .dev.vars.example .dev.vars   # preencha com os mesmos valores
npx wrangler pages dev public
```

Para o login Google funcionar localmente, adicione `http://localhost:8788` e
`http://localhost:8788/api/auth/callback` no Google Cloud.

## Limites do plano gratuito

- Arquivos estáticos (site, ícones, manifest): ilimitados.
- Funções (`/api/*`): 100.000 chamadas por dia, 10 ms de CPU por chamada. O streaming só repassa
  o corpo do Drive (não gasta CPU), mas cada "pulo" no vídeo faz uma nova chamada.
- Deploys: 500 builds por mês.

## Licença

Veja `LICENSE`.
