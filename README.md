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

## Modo público (sem login Google para visitantes)

O modo público permite que qualquer visitante navegue e reproduza os vídeos sem conectar uma Conta Google. Para isso, as pastas do Drive precisam estar compartilhadas como **Qualquer pessoa com o link → Leitor**.

> **Atenção:** esse compartilhamento não limita o acesso ao site. Qualquer pessoa que obtenha o link da pasta ou de um arquivo poderá abri-lo diretamente no Google Drive. Publique somente arquivos que você tem autorização para distribuir.

### Configuração

1. No Google Cloud Console, selecione o projeto usado pelo Acervo e confirme que a **Google Drive API** está ativada.
2. Em **APIs e serviços → Credenciais**, crie uma **chave de API**. Em Restrições da API, limite-a somente à **Google Drive API**. Como as chamadas são feitas pelo Cloudflare Worker, não restrinja por domínio HTTP (referenciador).
3. No Cloudflare, abra **Workers & Pages → acervo-do-cidjei → Settings → Variables and Secrets** e adicione:
   - `GOOGLE_DRIVE_API_KEY` — **Secret** — chave de API criada no Google Cloud.
   - `PUBLIC_STREAM_SECRET` — **Secret** — segredo aleatório com pelo menos 32 caracteres. No PowerShell, gere um valor com:
     ```powershell
     $bytes = New-Object byte[] 48
     $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
     $rng.GetBytes($bytes)
     $rng.Dispose()
     [Convert]::ToBase64String($bytes)
     ```
     Guarde o resultado diretamente como Secret no Cloudflare; não o coloque no GitHub nem no chat.
4. No Google Drive, compartilhe cada pasta cadastrada em `PUBLIC_DRIVE_FOLDER_IDS` como **Qualquer pessoa com o link — Leitor**.
5. Se algum link da pasta contiver o parâmetro `resourcekey=`, configure também `PUBLIC_DRIVE_FOLDER_RESOURCE_KEYS` como **Secret**, no formato `ID_DA_PASTA/RESOURCE_KEY,OUTRO_ID/OUTRA_RESOURCE_KEY`. Use a chave que aparece no próprio link de compartilhamento; não invente uma.
6. Salve as variáveis e publique uma nova versão do Worker pelo fluxo **Workers Builds** conectado ao GitHub.

A chave de API e o segredo de assinatura ficam no servidor e não são enviados ao navegador. O endpoint `/api/public/catalog` lista recursivamente os vídeos das pastas públicas. O endpoint `/api/stream/:id` valida um token HMAC assinado, emitido junto do catálogo, e repassa o conteúdo ao player com suporte a requisições `Range`. O catálogo fica em cache por um curto período para reduzir chamadas à API do Google.

### Verificação

- `/api/public/status` deve retornar `{"public":true,...}`.
- `/api/public/catalog` deve retornar `public: true`, os nomes das pastas e a lista de vídeos encontrados.
- Abra o site em uma janela anônima ou em outro dispositivo: a biblioteca deve carregar sem login Google.
- Teste reprodução, pausa e avanço/retrocesso em pelo menos dois vídeos.

Se o Google Drive informar que a pasta ou o arquivo não está acessível, confira o compartilhamento público e se a Google Drive API está ativada. O código mantém o modo OAuth antigo como alternativa quando `GOOGLE_DRIVE_API_KEY` não está configurada.

## Modo privado legado (OAuth)

Se preferir manter o acesso individual, remova o Secret `GOOGLE_DRIVE_API_KEY`. Nesse modo, os visitantes precisam entrar com a própria Conta Google, e as pastas continuam sendo verificadas pelas permissões individuais do Drive.

Para esse modo, configure como **Secrets** no Worker:
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `COOKIE_SECRET` — texto aleatório longo (por exemplo, gerado por `openssl rand -base64 48`)

O OAuth usa o escopo `https://www.googleapis.com/auth/drive.readonly`, classificado pelo Google como restrito. Aplicativos públicos que usam esse escopo podem precisar passar pela verificação de escopo restrito e avaliação de segurança. Consulte as [regras de verificação de escopos restritos](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification) e a [documentação de escopos do Drive](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

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
