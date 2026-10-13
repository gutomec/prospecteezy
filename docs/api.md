# prospecteezy — contratos da API REST

Base local: `http://localhost:3000` (porta via `PORT` no `.env`). Todas as respostas são JSON UTF-8. Mensagens de erro sempre em PT-BR no shape `{"error": "..."}`; erros inesperados viram `500` `{"error": "Erro interno no servidor. Tente novamente."}`.

## Segurança: só acesso local

A API não tem autenticação, então ela só aceita o próprio computador:

- O servidor escuta apenas em `127.0.0.1` (loopback). Outros aparelhos da rede não alcançam a porta. `http://localhost:PORT` e `http://127.0.0.1:PORT` funcionam.
- Não há CORS: nenhuma resposta envia `Access-Control-Allow-*` (nem as de `/api/wa/*`) e não existe resposta de preflight `OPTIONS`. Páginas de outros sites não conseguem ler os dados.
- Toda requisição à API (inclusive `/api/wa/*`) e a qualquer caminho desconhecido cujo cabeçalho `Host` não seja `localhost`, `127.0.0.1` ou `[::1]` com a porta do servidor recebe `403` `{"error": "Acesso negado: o prospecteezy só aceita requisições locais (localhost)."}` (proteção contra DNS rebinding). Exceção: as páginas da interface (`/`, `/leads`, `/whatsapp`, `/configuracoes`) e os arquivos do bundle são servidos pelo Bun sem esse filtro. Eles não carregam dados; tudo o que a página busca passa por `/api/*`, que continua protegido.
- Requisições que não são `GET`/`HEAD` com cabeçalho `Origin` diferente da própria origem (`http://localhost:PORT`, `http://127.0.0.1:PORT`, `http://[::1]:PORT`) recebem `403` `{"error": "Acesso negado: origem não autorizada."}`. Sem `Origin` (curl, scripts locais) passa. A UI servida pelo próprio servidor continua funcionando.

## POST /api/prospect

Dispara uma prospecção a partir do texto do chat.

Request:
```json
{ "text": "Busque os 100 principais escritórios de advocacia de São Paulo-SP", "tags": ["Advocacia"] }
```

`tags` (opcional): lista de tags aplicadas à pesquisa resolvida (inclusive em `"mais N"`), e por ela aos leads (veja [Tags](#tags)). Lista inválida → `400`.

Formas aceitas: `"Busque os N principais X de/em Y"`, `"top N X em Y"`, `"Traga os N melhores X no/na/nos/nas Y"`, continuação `"mais N"` / `"+N da mesma pesquisa"` (retoma a pesquisa **usada por último**, ou seja, a do job iniciado mais recentemente). Repetir a mesma query com novo N também continua do cursor — nunca duplica. A quantidade é só o número logo após o verbo/qualificador (`"academias 24 horas em Recife"` mantém "24 horas" no nicho e usa o padrão 20); deve ser pelo menos 1, sem limite superior, inclusive em `"mais N"`. A coleta para quando a fonte esgota ou quando o Google Maps responde com a mesma página da vez anterior (sinal de que não há mais resultados). Páginas só com empresas já coletadas por outras buscas não interrompem a coleta. Uma cláusula final `" com ..."` é removida da cidade (`"em Curitiba-PR com e-mail"` → `Curitiba-PR`).

Respostas:
- `202` `{ "job_id": "<uuid>", "search_id": 1, "steps": [ { "at": "...", "message": "..." } ], "already_running": false }` — job assíncrono iniciado.
- `202` com `"already_running": true` — a pesquisa resolvida já tem um job em andamento: o servidor **não** inicia outro (evita corrida no cursor e crédito Serper em dobro) e devolve o `job_id` desse job existente, que deve ser acompanhado normalmente. O `N` do novo pedido é ignorado; repita o pedido quando o job terminar.
- `422` `{ "error": "Não entendi o pedido. ..." }` — pedido ininteligível.
- `503` `{ "error": "SERPER_API_KEY ausente. Cadastre sua chave em Configurações → Serper, ou ..." }` — nenhuma chave do Serper (nem em Configurações, nem no `.env`). A chave salva em Configurações tem precedência sobre `SERPER_API_KEY` do `.env`.
- `400` — corpo inválido ou campo `text` vazio.

## GET /api/progress/:job

Polling do progresso (mensagens prontas para o chat, em PT-BR).

```json
{
  "job": {
    "id": "<uuid>",
    "status": "running | completed | failed",
    "search_id": 1,
    "steps": [ { "at": "2026-08-19T12:00:00.000Z", "message": "Página 3 processada: 30/100 novos leads (0 duplicados ignorados)." } ],
    "result": { "collected_new": 100, "duplicates_skipped": 4, "pages_consumed": 11, "enriched": 37, "exhausted": false },
    "error": null,
    "created_at": "...",
    "updated_at": "..."
  }
}
```

`result` é `null` enquanto `status = "running"`; `error` é preenchido quando `failed`. Jobs vivem em memória (reiniciar o servidor os descarta; os leads persistem no SQLite). Jobs terminados (`completed`/`failed`) há mais de 1 hora são descartados e passam a responder `404`; jobs em andamento nunca são descartados.

Durante o enriquecimento (5 sites visitados em paralelo) aparece um passo de progresso a cada 10 leads, por exemplo `"Enriquecimento em andamento: 20/57 sites visitados (8 e-mails encontrados)."`. Um site que falha não derruba o job: o lead fica marcado como enriquecido (sem e-mail) e não é tentado de novo automaticamente.

## GET /api/searches

```json
{ "searches": [ {
  "id": 1, "query_normalized": "escritorios de advocacia sao paulo-sp",
  "niche": "escritórios de advocacia", "city": "São Paulo-SP",
  "gl": "br", "hl": "pt-br", "created_at": "...", "last_used_at": "... | null",
  "exhausted_at": "2026-10-12T17:22:54.961Z | null",
  "last_page": 11, "total_collected": 100, "lead_count": 100,
  "tags": ["Advocacia", "Prioridade"],
  "status": "running | exhausted | idle", "running_job_id": "<uuid> | null"
} ] }
```

Ordem: `created_at` decrescente (a interface reordena por uso mais recente).

- `exhausted_at`: quando a última coleta desta busca esgotou a fonte (o Google Maps não devolveu mais resultados). É gravado ao fim de uma coleta com `exhausted: true` e apagado quando uma coleta posterior salva pelo menos 1 lead novo sem esgotar. Persistido no SQLite (`searches.exhausted_at`), sobrevive a reinícios.
- `tags`: nomes das tags da busca (ordem alfabética, sem acento/maiúsculas). Os leads que ela coleta herdam essas tags.
- `status`: `running` quando há um job coletando para a busca agora (`running_job_id` traz o id, para acompanhar via `GET /api/progress/:job`); senão `exhausted` quando `exhausted_at` tem menos de 24 horas; senão `idle`.

## POST /api/searches

Nova busca estruturada (fluxo "outra cidade / outro termo"), sem passar pelo parser de texto. Mesmo pipeline do chat: identidade nicho + cidade normalizada (acentos e maiúsculas ignorados), cursor, deduplicação e enriquecimento. Se a combinação já existe, a coleta continua do cursor dela.

Request:
```json
{ "niche": "clínicas de estética", "city": "Cascavel-PR", "count": 20, "tags": ["Estética"] }
```

`niche` e `city`: texto com 2 a 200 caracteres (espaços extras removidos). `count`: inteiro a partir de 1, sem limite superior (a coleta para quando a fonte esgota). `tags` (opcional): somadas às tags da busca quando a coleta começa (ou quando a busca já está em andamento); não são aplicadas em `409`/`503`/`400`.

Respostas:
- `202` `{ "job_id": "<uuid>", "search_id": 7, "steps": [...], "already_running": false }` (mesmo shape de `POST /api/prospect`).
- `202` com `"already_running": true` quando a busca já tem um job em andamento (o `count` novo é ignorado).
- `409` `{ "error": "Esta busca já esgotou os resultados do Google Maps nas últimas 24 horas. Tente outro termo ou outra cidade.", "code": "exhausted" }` quando a combinação existe e esgotou há menos de 24 horas. Nenhuma requisição ao Serper é feita.
- `400` corpo inválido, `niche`/`city` ausentes ou fora do tamanho, `count` não inteiro ou menor que 1 (mensagem diz qual campo).
- `503` sem chave do Serper (mesma mensagem de `POST /api/prospect`). Nada é criado.

## POST /api/searches/:id/more

"Buscar mais" para uma busca específica: o mesmo que "mais N" no chat, mas para o `id` indicado (não para a usada por último). Continua do cursor salvo.

Request: `{ "count": 20, "tags": ["Lote 2"] }` (`count` inteiro a partir de 1, obrigatório; `tags` opcional, somadas às da busca como em `POST /api/searches`).

Respostas:
- `202` `{ "job_id", "search_id", "steps", "already_running": false }`.
- `202` com `"already_running": true` e o `job_id` existente quando a busca já tem um job em andamento (um job por busca).
- `409` `{ "error": "...", "code": "exhausted" }` quando a busca esgotou há menos de 24 horas (mesma mensagem acima), sem chamar o Serper.
- `404` `{ "error": "Busca não encontrada." }` para id desconhecido.
- `400` `count` ausente ou inválido.
- `503` sem chave do Serper.

## PUT /api/searches/:id/tags

Substitui as tags da busca. Request: `{ "tags": ["Academia", "Prioridade"] }` (lista, pode ser vazia).

- Tags novas na busca também são aplicadas a todos os leads que ela **já** coletou (evento `tags_added` com `via: "search"`), e daí em diante a cada lead novo.
- Tags retiradas da busca **não** são retiradas dos leads (eles podem ter recebido a tag por outro caminho). Para tirar dos leads, use `POST /api/leads/tags` com `remove`.

Respostas: `200` `{ "search": { ...mesmo shape de GET /api/searches } }` · `404` busca inexistente · `400` lista inválida.

A ferramenta de IA `start_prospect_search` segue a mesma regra de 24 horas lendo `searches.exhausted_at`: devolve `exhausted: true` com `credits_used: 0` sem chamar o Serper.

## Tags

Rótulos livres em leads (muitos para muitos) e em buscas.

- Nome: texto de 1 a 40 caracteres, aparado, espaços internos colapsados. No máximo 20 tags distintas por requisição.
- Identidade: o `slug` (minúsculas, sem acentos): "Academia", "academia" e "Acadêmia" são a mesma tag. O `name` exibido é o primeiro visto.
- Tags de busca: todo lead **coletado** (inserido) por uma busca recebe as tags dela no momento da inserção (inclusive em "Buscar mais"). Um lead que já existia (duplicado de outra busca) não herda.
- Toda mudança grava `lead_events`: `tags_added` / `tags_removed` com payload `{ "tags": ["..."] }` (mais `via: "search"`, `search_id` quando veio da busca). Só leads que realmente mudaram ganham evento.
- Excluir um lead remove as tags dele (`lead_tags` tem `ON DELETE CASCADE`).

## GET /api/tags

`200` `{ "tags": [ { "id": 1, "name": "Academia", "slug": "academia", "lead_count": 12 } ] }`, ordenado por `slug`. Tags sem leads aparecem com `lead_count: 0`.

## POST /api/leads/tags

Adicionar e/ou remover tags em massa. Request:

```json
{ "lead_ids": [1, 2, 3], "add": ["Quente"], "remove": ["frio"] }
```

`lead_ids`: pelo menos 1 inteiro, sem limite (repetidos unificados, inexistentes ignorados). `add`/`remove`: listas opcionais, pelo menos uma tag no total. `add` cria as tags que faltam; `remove` casa por nome ou slug (tag desconhecida é ignorada).

Respostas: `200` `{ "updated": 2, "tags": [ ...mesmo shape de GET /api/tags, já atualizado ] }` (`updated` = leads que de fato mudaram) · `400` corpo inválido.

## GET /api/leads

Query params: `search_id` (opcional; inteiro positivo, senão `400`), `filter` (LIKE sobre nome/categoria/endereço/telefone/e-mail/site), `tags` (opcional; nomes ou slugs separados por vírgula), `tags_mode` (`any` = qualquer uma, padrão; `all` = todas; outro valor → `400`), `sort` (`coluna` ou `coluna:desc`; colunas: `id,name,category,rating,rating_count,position,collected_at,is_whatsapp`; coluna desconhecida é ignorada e ordena por `id`), `page` (1-based; valor inválido vira 1), `page_size` (padrão 50, máx 500; valor inválido vira 50).

```json
{ "leads": [ {
  "id": 1, "search_id": 1, "place_id": "ChIJ...", "cid": "123...", "position": 1,
  "name": "Escritório X", "category": "Advogado", "address": "Rua ..., São Paulo - SP",
  "latitude": -23.55, "longitude": -46.63, "phone": "+55 11 ...", "website": "https://...",
  "rating": 4.8, "rating_count": 213,
  "email": "contato@x.com.br", "socials_json": "{\"instagram\":\"https://...\"}",
  "is_whatsapp": null, "whatsapp_jid": null,
  "source": "serper:places", "collected_at": "2026-08-19T...", "enriched_at": "2026-08-19T...",
  "tags": ["Advocacia", "Quente"]
} ], "total": 100, "page": 1, "page_size": 50 }
```

`tags`: nomes das tags do lead, em ordem alfabética (uma consulta agrupada por página).

Campos nulos quando a fonte não fornece. `is_whatsapp`: `1`/`0`/`null` (não validado) — preenchido pela fase whatsapp-module (contrato em `src/whatsapp/README.md`).

## POST /api/leads/enrich

Enriquecimento manual de e-mails dos leads selecionados (mesmo crawler da prospecção). Roda para todos os IDs informados que tenham site, **independentemente** de já terem sido enriquecidos antes. IDs inexistentes ou leads sem site são ignorados (e contados num passo do job).

Request: `{ "ids": [1, 2, 3] }` — de 1 a 1000 inteiros (repetidos são unificados).

Respostas:
- `202` `{ "job_id": "<uuid>" }` — job assíncrono iniciado; acompanhe com `GET /api/progress/:job`. O job tem o mesmo shape dos jobs de prospecção: `search_id` é `null`, `status` é `running | completed | failed`, os passos estão em PT-BR e `result` é `{ "collected_new": 0, "duplicates_skipped": 0, "pages_consumed": 0, "enriched": <e-mails encontrados>, "exhausted": false }`.
- `400` `{ "error": "Corpo inválido. Envie JSON: {\"ids\": [1, 2, 3]} com pelo menos 1 ID de lead." }` — corpo não-JSON, `ids` ausente, vazio ou com algo que não seja inteiro.

Regras do crawler (valem para a prospecção também): só `http`/`https`; hosts que são ou resolvem para endereços locais/privados (loopback, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, 0.0.0.0, `::1`, fc00::/7, fe80::/10) são recusados, inclusive em redirecionamentos (no máximo 3, cada `Location` é checado); respostas acima de 2 MB são descartadas/truncadas; o robots.txt é respeitado por caminho (grupo `prospecteezy` ou `*`). Na escolha do e-mail principal, um endereço do próprio domínio do site tem preferência; e-mails de lixo (sentry.io, wixpress.com, example.com etc.) são descartados.

## GET /api/leads/:id

`200` `{ "lead": { ...mesmo shape acima, com "tags" } }` · `404` `{ "error": "Lead não encontrado." }`

## POST /api/leads/:id/events

Anexa um evento à trilha de auditoria do lead.

Request: `{ "event": "whatsapp_validated", "payload": { "jid": "5511...@s.whatsapp.net" } }` → `201` `{ "ok": true }`.

## Interface web

`GET /`, `/leads`, `/whatsapp` e `/configuracoes` devolvem o `index.html` da interface React (`src/client`, lista `APP_PATHS` em `src/client/routes.ts`). O Bun empacota a interface a partir do HTML import: com `NODE_ENV=development`, com HMR; caso contrário, minificada e em cache na memória (gerada na primeira requisição). Os arquivos do bundle (`/chunk-*.js`, `/chunk-*.css`, ícones) vêm do próprio Bun.

Qualquer outro caminho fora de `/api/*` responde `404` `{"error": "Não encontrado."}`; caminho desconhecido em `/api/*` responde `404` `{"error": "Rota não encontrada."}`.

---

# Configurações e camada de IA (opcional)

Tudo abaixo passa pela mesma proteção de `Host`/`Origin` descrita em "Segurança". Sem provedor de IA ativo, o app se comporta exatamente como antes (`/api/prospect` inalterado) e `POST /api/chat` responde `409`.

## Segredos

Chaves (Serper e provedores de IA) ficam no SQLite cifradas com AES-256-GCM (`v1:<iv b64>:<cifra+tag b64>`). A chave mestra tem 32 bytes aleatórios em `data/.master.key` (criada no primeiro salvamento, modo `0600`). Nenhuma rota devolve uma chave: só `last4` (últimos 4 caracteres; `null` se a chave tiver 4 caracteres ou menos). Se a chave mestra sumir ou mudar, os valores cifrados passam a contar como "não configurados" e `GET /api/settings` sinaliza `secrets_unreadable: true`.

## GET /api/settings

```json
{
  "serper": { "configured": true, "source": "settings | env | null", "last4": "1234 | null" },
  "company_profile": { "name": "...", "offering": "..." } ,
  "secrets_unreadable": false
}
```

`company_profile` é `null` quando vazio. Quando `secrets_unreadable` é `true`, vem também `"warning": "<texto PT-BR>"`. `source: "env"` = usando `SERPER_API_KEY` do `.env`.

## PUT /api/settings/serper

Request `{ "api_key": "..." }` (aparado; obrigatório, até 500 caracteres) → `200` com o mesmo shape de `serper` acima. `400` se vazio.

## DELETE /api/settings/serper

→ `200` com o shape de `serper` (volta para o `.env` se houver `SERPER_API_KEY`).

## POST /api/settings/serper/test

Gasta **1 crédito** (endpoint `autocomplete`). → `200` `{ "ok": true }` ou `{ "ok": false, "error": "..." }` (inclusive quando não há chave). A chave nunca aparece no erro.

## PUT /api/settings/company

Request com qualquer subconjunto dos campos (todos texto, até 4000 caracteres cada): `name, website, description, offering, target_customers, differentiators, tone, signature, call_to_action, extra_instructions`. Campos desconhecidos são ignorados, campos vazios são descartados. O perfil é **substituído** (não mesclado). → `200` `{ "company_profile": {...} | null }` (`null` se tudo vazio). `400` se algum campo não for texto ou passar do limite.

## GET /api/ai/status

```json
{ "enabled": true, "provider": { "id": "uuid", "kind": "openai", "label": "Minha OpenAI", "model": "gpt-5-mini" } }
```

`{ "enabled": false, "provider": null }` = modo clássico.

## GET /api/ai/providers

```json
{ "providers": [ {
  "id": "uuid", "kind": "openai | google | anthropic | openrouter | openai_compatible",
  "label": "...", "model": "...", "base_url": "http://... | null",
  "has_key": true, "last4": "1234 | null", "is_active": true, "created_at": "..."
} ] }
```

## POST /api/ai/providers

Request `{ "kind", "label"?, "model", "api_key"?, "base_url"? }` → `201` `{ "provider": {...mesmo shape} }`. O primeiro provedor (quando nenhum está ativo) já nasce ativo. `label` vazio vira o nome do tipo ("OpenAI", "Google Gemini", "Anthropic", "OpenRouter", "Compatível com OpenAI"). `base_url` é aceito em qualquer tipo (http/https) e é obrigatório em `openai_compatible`; `api_key` é obrigatória em todos os tipos, exceto `openai_compatible` (ex.: Ollama). `400` PT-BR para tipo inválido, modelo ausente, URL ausente/inválida ou chave ausente.

## PATCH /api/ai/providers/:id

Request `{ "label"?, "model"?, "api_key"?, "base_url"? }` → `200` `{ "provider" }`. `api_key` omitida ou vazia mantém a atual. `kind` não muda. `base_url: ""` limpa a URL (exceto em `openai_compatible`, onde é `400`). `404` se não existir.

## DELETE /api/ai/providers/:id

→ `200` `{ "ok": true }`. Excluir o ativo deixa a IA desativada. `404` se não existir.

## POST /api/ai/providers/:id/activate

→ `200` `{ "provider" }`. No máximo um ativo (troca atômica). `404` se não existir.

## POST /api/ai/deactivate

→ `200` `{ "ok": true }`. Nenhum ativo = modo clássico.

## POST /api/ai/providers/:id/test

Chama o modelo com "Responda apenas: ok" (timeout 20 s, sem novas tentativas). → `200` `{ "ok": true, "latency_ms": 812 }` ou `{ "ok": false, "error": "<PT-BR>", "latency_ms": 95 }`. `404` se não existir.

## GET /api/ai/models?kind=<kind>

→ `200` `{ "kind": "openai", "models": [ { "id": "gpt-5-mini", "label": "GPT-5 mini (econômico)" } ] }`. Lista sugerida e estática; qualquer id de modelo é aceito. `400` se `kind` faltar ou for inválido.

## POST /api/chat (AI SDK v7, `useChat`)

Endpoint do chat React (`useChat` de `@ai-sdk/react` + AI Elements). Fala o **protocolo de UI message stream do AI SDK v7**: resposta `text/event-stream` com `x-vercel-ai-ui-message-stream: v1`, um chunk JSON por frame `data: {...}` e `data: [DONE]` no fim. O agente (ferramentas, prompt, regras de aprovação, contagem de créditos Serper, envio ao lead) está em `src/ai/agent.ts` e `src/ai/tools.ts`; limite de 12 passos e 120 s por execução.

**Fonte da verdade = servidor.** O histórico fica na tabela `ai_chats` como `UIMessage[]`, por `id` de conversa. Do corpo, o servidor lê só a **última** mensagem: uma mensagem nova do usuário ou a mensagem do assistente com as decisões de aprovação. O resto do que o cliente manda é ignorado. Assim uma aprovação repetida, atrasada ou forjada nunca executa uma ação duas vezes (ela é comparada com as aprovações pendentes **gravadas**), e há no máximo uma execução por conversa ao mesmo tempo.

### Configuração do cliente

```tsx
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";

const { messages, sendMessage, addToolApprovalResponse, regenerate, status, error } = useChat({
  id: chatId,                       // id da conversa (crie com crypto.randomUUID())
  messages: initialMessages,        // de GET /api/chat/:id/messages
  transport: new DefaultChatTransport({
    api: "/api/chat",
    // opcional (recomendado): mandar só a última mensagem
    prepareSendMessagesRequest: ({ id, messages, trigger, messageId, body }) => ({
      body: { ...body, id, trigger, messageId, message: messages.at(-1) },
    }),
  }),
  sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  onData: (part) => { /* data-credits, data-error */ },
});
```

### Corpo aceito

O que o `DefaultChatTransport` manda: `{ "id": "<chat id>", "messages": UIMessage[], "trigger": "submit-message" | "regenerate-message", "messageId"?: "..." }`, mais o que vier em `body`. Também aceita `"message": UIMessage` no lugar de `messages` (versão "só a última"). Prioridade:

1. `action: { "type": "send_draft", "lead_id": 1, "text": "<texto atual do rascunho>" }` — o botão "Enviar pelo WhatsApp" do card de rascunho. Sem chamar o LLM, o servidor cria uma chamada `send_whatsapp_message` que **também** espera aprovação, continuando a última mensagem do assistente. No cliente: `sendMessage(undefined, { body: { action: { type: "send_draft", lead_id, text } } })`. `400` se texto vazio/maior que 4096, lead inexistente ou sem WhatsApp validado.
2. `trigger: "regenerate-message"` (`regenerate()`): descarta a última resposta do assistente e responde de novo a última mensagem do usuário. É o "tentar de novo" depois de um erro.
3. Última mensagem com `role: "assistant"`: decisões de aprovação. O servidor lê as partes de ferramenta em `state: "approval-responded"` (`approval: { id, approved, reason? }`). Cada `approval.id` precisa estar pendente na conversa gravada; todas as pendentes da mensagem precisam ser respondidas. Senão `400` ("Aprovação não encontrada ou já respondida." / "Responda todas as aprovações pendentes desta mensagem.").
4. Última mensagem com `role: "user"`: só as partes `text` são usadas (até 20.000 caracteres). Reenviar o mesmo `id` só roda de novo se ela ainda estiver sem resposta; senão `400`. Uma mensagem nova com aprovações pendentes **recusa** essas aprovações (ficam `output-denied`, motivo "O usuário seguiu a conversa sem decidir."). O card antigo no cliente continua mostrando "aguardando"; trate `approval-requested` fora da última mensagem como expirado, ou recarregue com `GET /api/chat/:id/messages` no `onFinish`.

Erros fora do stream (JSON): `409` `{ "error": "A inteligência artificial está desativada. ...", "code": "ai_disabled" }`; `409` `{ "error": "Já existe uma resposta em andamento nesta conversa. Aguarde terminar." }`; `400` `{ "error": "..." }` (corpo inválido, sem `id`, `trigger` inválido, mensagem vazia, aprovação inválida).

### Chunks do stream (o que o `useChat` monta em `message.parts`)

| Chunk | Quando |
|---|---|
| `start` `{ messageId }` | sempre primeiro. Numa continuação (aprovação, `send_draft`) é o id da última mensagem do assistente, que é **estendida** |
| `start-step` / `finish-step` | cada passo do agente (até 12) |
| `text-start` / `text-delta` / `text-end` | texto do assistente |
| `reasoning-*` | raciocínio, quando o modelo envia |
| `tool-input-start` / `tool-input-delta` / `tool-input-available` `{ toolCallId, toolName, input }` | chamada de ferramenta |
| `tool-approval-request` `{ approvalId, toolCallId, approvalDescriptor }` | ação aguardando aprovação; a parte fica `state: "approval-requested"` com `approval: { id, descriptor }` |
| `tool-output-available` `{ toolCallId, output }` | resultado (shapes abaixo) |
| `tool-output-error` `{ toolCallId, errorText }` | ferramenta falhou (texto PT-BR) |
| `tool-output-denied` `{ toolCallId }` | recusada |
| `data-credits` `{ id: "credits", data: { credits_thread, credits_run } }` | antes de `finish` (e antes de `error`). Fica gravado na mensagem (mesmo `id` → substitui) |
| `data-error` `{ transient: true, data: { code, message } }` | logo antes de `error`; não é gravado. Chega no `onData` |
| `error` `{ errorText }` | falha do LLM/tempo limite; `errorText` é a mensagem PT-BR (o `useChat` vira `status: "error"`, `error.message`) |
| `finish` `{ finishReason }` | fim |

`code` do `data-error`: `llm_auth` (chave recusada/ilegível), `llm_quota` (limite/saldo), `llm_unavailable` (provedor fora do ar, rede, tempo limite de 120 s), `llm_error` (outros). A chave nunca aparece no texto. Desconectar o cliente aborta a execução.

### Aprovações (fluxo nativo do v7)

Partes de ferramenta (`type: "tool-<nome>"`) passam por `input-streaming → input-available → approval-requested → approval-responded → output-available | output-error | output-denied`. Ferramentas com aprovação: `start_prospect_search`, `serper_search`, `scrape_webpage`, `crawl_lead_website`, `save_lead_enrichment`, `send_whatsapp_message`. As outras executam direto.

`approval.descriptor` (dados do card): `{ "title": "Consultar o Google via Serper: Busca", "description": "...", "params": [ { "label": "q", "value": "padarias recife" } ], "estimated_credits": 1 }`.

Para responder: `addToolApprovalResponse({ id: part.approval.id, approved: true })` ou `({ id, approved: false, reason: "caro demais" })`. Com `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses`, o `useChat` reenvia sozinho quando todas as aprovações da mensagem foram respondidas; o servidor executa as aprovadas (uma única vez), registra as recusadas como `output-denied` e o modelo continua na **mesma** mensagem do assistente. Se a execução for interrompida no meio (queda, servidor reiniciado), a parte vira `output-error` ("Execução interrompida antes de terminar; a ação pode não ter sido concluída.") e nunca é reexecutada sozinha.

### Saídas estruturadas das ferramentas (`part.output`)

- `query_leads` → `{ "total": 12, "leads": [ { "id", "search_id", "name", "category", "address", "phone", "email", "website", "rating", "is_whatsapp": 1|0|null, "has_ai_enrichment": false } ] }`
- `present_message_draft` → `{ "lead_id": 1, "lead_name": "Padaria Pão Bom", "text": "Olá...", "can_send_whatsapp": true, "shown_to_user": true }`; sem WhatsApp validado: `can_send_whatsapp: false` e `"reason": "Lead sem WhatsApp validado: ..."`. O card de rascunho usa `send_draft` (acima) para enviar
- `start_prospect_search` → `{ "job_id", "search_id", "already_running": false, "note" }` — acompanhe com `GET /api/progress/:job`
- `serper_search` → `{ "type", "credits", "results": { ...corpo do Serper enxugado } }`
- `scrape_webpage` → `{ "url", "credits", "metadata", "text", "truncated" }` (texto até 12.000 caracteres)
- `crawl_lead_website` → `{ "lead_id", "website", "email", "socials", "pages_visited", "skipped_by_robots" }`
- `save_lead_enrichment` → `{ "saved": true, "lead_id", "email_saved" }`
- `send_whatsapp_message` → `{ "sent": true, "lead_id" }` ou `{ "sent": false, "lead_id", "code", "reason" }`
- `get_company_profile` → `{ "profile": {...} | null, "note"? }`; `list_searches` → `{ "searches": [...] }`; `get_lead` → `{ "lead": {...}, "events": [...] }`; `lead_stats` → `{ "total", "with_email", "with_website", "whatsapp": { "yes", "no", "unknown" }, "with_ai_enrichment", "per_search": [...] }`

### Exemplo de stream (aprovação aceita)

```
data: {"type":"start","messageId":"msg-1a2b"}
data: {"type":"tool-output-available","toolCallId":"call-1","output":{"type":"search","credits":1,"results":{"organic":[...]}}}
data: {"type":"start-step"}
data: {"type":"text-start","id":"t1"}
data: {"type":"text-delta","id":"t1","delta":"Encontrei a Padaria Real."}
data: {"type":"text-end","id":"t1"}
data: {"type":"finish-step"}
data: {"type":"data-credits","id":"credits","data":{"credits_thread":1,"credits_run":1}}
data: {"type":"finish","finishReason":"stop"}
data: [DONE]
```

## GET /api/chat

Conversas recentes (até 100, mais recente primeiro): `{ "chats": [ { "id", "title", "credits_used", "created_at", "updated_at" } ] }`. `title` = primeira mensagem do usuário (até 80 caracteres) ou `null`.

## GET /api/chat/:id/messages

`{ "id", "title", "credits_used", "running": false, "messages": UIMessage[] }` — passe `messages` como `messages` inicial do `useChat`. `404` `{ "error": "Conversa não encontrada." }`.

## DELETE /api/chat/:id

`{ "ok": true }`; `404` se não existe; `409` se a conversa está respondendo agora.

### Ferramentas

Sem aprovação (só leitura local): `get_company_profile`, `list_searches`, `query_leads`, `get_lead`, `lead_stats`, `present_message_draft` (não grava nada).
`query_leads` aceita `tags` (lista; leads com qualquer uma delas) e devolve `tags` em cada lead; `get_lead` e `list_searches` também trazem `tags`.
Com aprovação: `start_prospect_search {niche, city, count ≥ 1 (sem limite superior), tags?}` (as tags vão para a busca e aparecem no cartão de aprovação), `serper_search {type, q?, gl="br", hl="pt-br", location?, num?, page?, tbs?, ll?, cid?, placeId?, fid?, url?, sortBy?, nextPageToken?}` (tipos: search, images, videos, news, shopping, scholar, patents, places, maps, reviews, autocomplete, lens, product-reviews, maps-autocomplete; o webpage fica com `scrape_webpage`), `scrape_webpage {url, includeMarkdown?}`, `crawl_lead_website {lead_id}`, `save_lead_enrichment {lead_id, enrichment, email?}`, `send_whatsapp_message {lead_id, text}`. Parâmetros inválidos (ex.: `serper_search` do tipo `reviews` sem `cid`/`fid`/`placeId`) falham antes da aprovação e não gastam crédito.

`save_lead_enrichment` grava `leads.ai_enrichment_json` (`{ summary, segment, size_estimate, decision_makers:[{name, role, source_url}], socials:{...}, extra_emails:[], extra_phones:[], notes, sources:[] }`, todos opcionais) e `leads.ai_enriched_at`; o e-mail só é gravado se o lead não tiver; cria o evento `ai_enriched` com payload `{ source: "ai:<kind>", fields: [...], email? }`. `GET /api/leads` e `GET /api/leads/:id` trazem essas duas colunas.

`send_whatsapp_message` usa o mesmo caminho protegido de `POST /api/wa/send`: lead com `is_whatsapp = 1` e `whatsapp_jid`, instância ativa conectada, limite anti-banimento e horário silencioso (só é liberado se o lead já tiver escrito para nós). Resultado: `{ "sent": true, "lead_id" }` ou `{ "sent": false, "lead_id", "code": "lead_not_found | not_whatsapp | no_instance | blocked | send_failed", "reason": "<PT-BR>" }`.

O antigo endpoint AG-UI (`POST /api/agent`) foi removido. A tabela `ai_threads` que ele usava continua no banco, sem uso; as conversas dele não aparecem em `/api/chat`.

---

# WhatsApp: mídia (resumo)

Contrato completo em `src/whatsapp/README.md`, seção 8.

- `GET /api/wa/chats/:jid/messages` — cada mensagem traz `media` (`{kind: image|video|audio|voice|document|sticker, mimetype, file_name, file_size, duration_s, width, height, has_thumbnail, available, cached}` ou `null`; `cached: true` = o arquivo já está no disco e exibi-lo não baixa nada), `quoted` (`{id, text, type}` ou `null`) e `reactions` (`[{emoji, from_me}]`). Reações não aparecem como mensagens.
- `GET /api/wa/messages/media?instance=&chat=&id=&from_me=0|1` — download sob demanda com cache, `Range` (206/416), `Content-Disposition` inline (mídia) ou attachment com nome RFC 5987 (documento). Erros `{error, code}`: `404 media_unavailable` ("Mídia indisponível (recebida antes da atualização)."), `404 message_not_found`, `404 not_media`, `409 not_connected`, `413 too_large`, `502 download_failed`.
- `GET /api/wa/messages/thumbnail?<mesmos parâmetros>` — `image/jpeg` ou `404 no_thumbnail`.
- Mídia sob demanda (nada é baixado por padrão; a interface pergunta antes):
  - `GET /api/wa/chats/:jid/media-summary?instance=` → `{total, cached, downloadable, unavailable, downloadable_bytes, unknown_size_count, cached_bytes}`. `downloadable` = chaves guardadas e ainda não baixado; `unavailable` = sem chaves (recebida antes da atualização); `downloadable_bytes` soma só os tamanhos conhecidos (`unknown_size_count` conta os desconhecidos).
  - `POST /api/wa/chats/:jid/media/download {instance}` → `202 {job_id}`. Baixa toda mídia `downloadable` da conversa, 2 por vez, pelo mesmo caminho do download avulso (cache, reupload em 403/404/410, fallback de DNS); acima de 100 MB é pulado com `code: "too_large"`. `409 not_connected` sem socket conectado; `409 job_running` (com `job_id`) se já há um job nesta conversa.
  - `GET /api/wa/media-jobs/:id` → `{status: running|done|failed, total, done, failed, bytes, errors: [{message_id, code}]}` (`done` = baixados com sucesso; `404` id desconhecido; jobs vivem em memória).
  - `POST /api/wa/chats/:jid/media/recover {instance}` → `{requested, recovered, still_unavailable}`. Pede ao celular o histórico da conversa (history sync sob demanda, até 50 mensagens por pedido, ancorado na mensagem mais recente e voltando página a página; até 6 pedidos e 45 s no total) para que mensagens antigas guardem as chaves da mídia. Síncrono (responde ao fim). `409 not_connected`; `409 recover_running` se já há uma recuperação nesta conversa.
- `POST /api/wa/send` — `{instance, jid, text}` ou `{instance, jid, media_id, caption?, voice?}` (`media_id` de `POST /api/wa/media`). Limites: imagem 16 MB, vídeo 64 MB, áudio 16 MB, documento 100 MB.
- SSE `GET /api/wa/stream` — `message` com `media`/`quoted`; evento `reaction` `{instance, chat_jid, target_id, emoji, from_me, removed}`; evento `message_status` `{instance, chat_jid, message_id, from_me, status}` (`status`: `pending | sent | delivered | read | played | error`) quando o WhatsApp confirma entrega/leitura de uma mensagem já espelhada (os "tiques" ao vivo).
