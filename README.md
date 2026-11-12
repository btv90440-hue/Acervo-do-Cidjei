# Acervo do Cidjei

Biblioteca e player de filmes compartilhados em pastas do Google Drive.
Hospedado como **Cloudflare Worker com arquivos estáticos** (plano gratuito).

## Estrutura

```
wrangler.jsonc               <- configuração (nome do Worker, pasta public/, rota /api/*)
src/
  worker.js                  <- roteador: só /api/* executa código
  api/session.js             <- POST/DELETE /api/session
  api/stream.js              <- GET /api/stream/:id  (ponte de streaming do Drive, com Range)
  api/auth.js                <- /api/auth/{status,login,callback,refresh,logout}
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
4. Edite `PUBLIC_DRIVE_FOLDER_IDS` em `wrangler.jsonc` com os IDs das pastas autorizadas, separados por vírgulas. Exemplo: `ID_DA_PASTA_1,ID_DA_PASTA_2`.
5. Compartilhe cada pasta no Google Drive com os e-mails Google das pessoas autorizadas. A lista configurada não concede acesso por si só: cada visitante entra com a própria conta Google, e o Drive verifica a permissão individual.
6. Faça um novo deploy (um commit novo, ou **Deployments → Retry build**).

O nome em `wrangler.jsonc` (`acervo-do-cidjei`) precisa ser igual ao nome do Worker no painel.

### Alternativa pela linha de comando

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put COOKIE_SECRET
npx wrangler deploy
```

`PUBLIC_DRIVE_FOLDER_IDS` é uma variável normal, não um Secret. Para testar localmente, preencha também a mesma variável em `.dev.vars`.

## Google Cloud (obrigatório ao trocar de domínio)

No [Google Cloud Console](https://console.cloud.google.com/apis/credentials), no seu *OAuth client ID* da web, adicione:

- **Origens JavaScript autorizadas:** `https://acervo-do-cidjei.btv90440.workers.dev`
- **URIs de redirecionamento autorizados:**
  - `https://acervo-do-cidjei.btv90440.workers.dev/`
  - `https://acervo-do-cidjei.btv90440.workers.dev/api/auth/callback`

Mantenha a **Google Drive API** ativada. Se usar domínio próprio, adicione também as URLs dele. O login é individual; cada pessoa só verá arquivos das pastas compartilhadas com a sua conta Google.

## Verificação do app OAuth

O código e estas páginas deixam o projeto preparado, mas o aviso “app não verificado” só desaparece depois da aprovação do Google. O escopo usado para localizar pastas e transmitir vídeos é `https://www.googleapis.com/auth/drive.readonly`, que o Google classifica como **restrito**. Não foi trocado por `drive.file`, pois esse escopo não permite consultar automaticamente pastas fixas que o visitante já recebeu por compartilhamento. Como o Worker intermedeia a API e o streaming, o projeto deve se preparar para a verificação de escopo restrito e para uma avaliação de segurança anual por avaliador aprovado pelo Google. O uso não comercial, por si só, não remove essas exigências. Consulte as [etapas de envio para verificação](https://support.google.com/cloud/answer/13461325?hl=pt-BR), os [requisitos para escopos restritos](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification) e a [classificação dos escopos do Drive](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

Antes de enviar:

1. Substitua o e-mail de contato indicado em `public/privacidade.html` e `public/termos.html` por um endereço válido.
2. Publique o site e as páginas de privacidade e termos em HTTPS. Verifique no Google Search Console um domínio que você controla e configure-o como domínio autorizado no projeto OAuth. Se a verificação não aceitar o endereço `workers.dev`, será necessário usar um domínio próprio no Worker.
3. No Google Cloud Console, preencha nome do app, e-mail de suporte, domínio autorizado, página inicial, política de privacidade e contatos do desenvolvedor. Adicione os escopos que o código realmente usa: `openid`, `email` e `https://www.googleapis.com/auth/drive.readonly`.
4. Publique o app em **Production** e inicie **Prepare for Verification**. Explique por que a leitura do Drive é necessária, envie uma demonstração do fluxo de login, pastas compartilhadas e reprodução, e contrate o avaliador de segurança aprovado caso o Google exija a avaliação CASA.
5. Aguarde a revisão do Google. Enquanto o app estiver em Testing, usuários fora da lista de testadores podem ver o aviso ou não conseguir entrar.

Texto-base para justificar o escopo: “O Acervo usa acesso somente de leitura ao Google Drive para localizar vídeos em IDs de pastas configurados pelo responsável e compartilhados diretamente com cada usuário. O usuário entra com sua própria Conta Google; a aplicação usa o Drive para mostrar os nomes dos vídeos e transmitir somente o arquivo selecionado. A aplicação não cria, altera, exclui nem compartilha arquivos. O acesso pode ser revogado nas configurações da Conta Google.” Revise o texto para refletir exatamente o comportamento publicado. A Google API Services User Data Policy e as decisões do processo de avaliação prevalecem.

## Conferir se funcionou

- `https://acervo-do-cidjei.btv90440.workers.dev/api/auth/status` deve mostrar `{"configured":true}`.
- Ao abrir “Conta” no site, o campo “ID de cliente OAuth” não deve aparecer.
- `/api/auth/status` também informa as pastas fixadas em `PUBLIC_DRIVE_FOLDER_IDS`.

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
