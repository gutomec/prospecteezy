# Módulo WhatsApp — número dedicado, validação em lote e contatos

Implementado pela fase **whatsapp-module** (squad `agentic-whatsapp-nirvana`, padrões portados do template do squad — o squad global em `~/squads/` permanece intocado). Stack: Baileys `7.0.0-rc13` sobre **Bun** (nunca Node), sessão persistida em SQLite.

## Aviso de risco (leia antes de parear)

- Use um **número dedicado novo**, nunca o seu número pessoal. Automação via Baileys opera fora da API oficial e infringe os Termos de Serviço do WhatsApp; a conta pode ser banida.
- Os gates anti-ban ficam **sempre ligados**, com dois orçamentos separados em `wa_actions` (por `kind`): **envios** (`message_send`) com 2/min e 20/h, espaçamento mínimo de 60s ÷ max_per_minute (30s) mais jitter, e quiet hours 21h–08h (America/Sao_Paulo); **consultas de validação** (`onwhatsapp_lookup`) com 10/min e 200/h, jitter de 3–7s e **sem** quiet hours (a consulta é silenciosa, não entrega mensagem a ninguém). Uma validação nunca consome o orçamento de envio, e vice-versa. Não os desligue; ajuste apenas em `config.ts`, para baixo.
- O envio de mensagem passa **sempre pelo gate** (`reserveSend`, único caminho ao socket): checagem e reserva da vaga numa transação `IMMEDIATE`, **antes** de esperar o socket, então envios concorrentes nunca furam o limite (um envio que falha mantém a vaga reservada — conservador). Em `POST /api/wa/send`, as quiet hours só são afrouxadas para **resposta**: quando o chat já tem mensagem recebida do contato (`from_me=0`). Primeira mensagem fria à noite → 409 com `blocked_code:"quiet_hours"`.

## Bancos de dados

| Arquivo | Dono | Conteúdo |
|---|---|---|
| `data/prospecteezy.db` | core | `leads` (`is_whatsapp`, `whatsapp_jid`), `lead_events` — o módulo escreve nas colunas que o core já criou |
| `data/whatsapp.db` | este módulo | `auth_state` (sessão Baileys/chaves Signal), `wa_actions` (contabilidade do rate limit), `wa_entities` (registro CRM de contatos), `runtime_state` |

Banco dedicado por decisão: as migrações do core usam `PRAGMA user_version` próprio (tabelas novas lá colidiriam com o contador), e apagar a sessão (`data/whatsapp.db`) nunca pode arriscar os leads. Segue a convenção do squad (`data/whatsapp.db`). Ambos já estão no `.gitignore` (`data/*.db`).

## 1. Parear o número dedicado

```bash
bun run wa:pair                                  # QR no terminal (default)
bun run wa:pair --method code --phone +5511999999999   # pairing code de 8 caracteres
bun run wa:pair --timeout 600                    # espera mais tempo (default 300s)
```

No aparelho dedicado: **WhatsApp → Dispositivos conectados → Conectar dispositivo** e escaneie o QR (ou digite o código, em "Conectar com número de telefone"). O QR rotaciona a cada ~20–60s e o script imprime o vigente automaticamente — o socket fica aberto até parear ou estourar o timeout (regra de protocolo: o QR está amarrado às chaves do socket que o gerou).

O script também emite NDJSON em stdout (`{"event":"qr",...}`, `{"event":"pairing_code",...}`, `{"event":"result",...}`) para consumo por máquina. A sessão fica em `data/whatsapp.db` e sobrevive a reinícios; para trocar de número, rode `bun run wa:pair --force` (descarta só as credenciais dessa sessão; chats, contatos e outras instâncias ficam). Se a sessão for desconectada no celular (401), o auth dessa instância é apagado automaticamente e basta parear de novo — não é preciso apagar o banco.

O pareamento é **ação humana** — o sistema gera o QR/código, a confirmação acontece no aparelho.

## 2. Validar leads em lote

```bash
bun run wa:validate --search 1          # leads pendentes (is_whatsapp IS NULL) da pesquisa 1
bun run wa:validate --leads 12,13,14    # ids específicos
bun run wa:validate --search 1 --limit 10
```

Para cada lead com telefone, o módulo consulta `sock.onWhatsApp` com **todas as variantes do nono dígito BR de uma vez** (lógica do `recipient-resolver` do squad) e grava o resultado:

| Resultado | `is_whatsapp` | `whatsapp_jid` | `lead_events` |
|---|---|---|---|
| Conta existe | `1` | JID canônico do servidor | `whatsapp_validated` `{result:"exists"}` |
| Não registrado | `0` | `NULL` | `{result:"not_registered"}` |
| **AMBIGUOUS** (duas contas) | `NULL` | `NULL` (nunca chuta) | `{result:"ambiguous", requires_human_decision:true, candidates:[...]}` |
| Sem telefone / inválido | `NULL` | `NULL` | `{result:"skipped"}` |
| Consulta não respondeu | `NULL` | `NULL` | `{result:"lookup_failed"}` |

Regras duras herdadas do incidente do squad (2026-07-26):

- Número inexistente vem **AUSENTE** do array do `onWhatsApp` — nunca `exists:false`. O casamento é **sempre pelo `jid` retornado, nunca por índice**.
- 13 dígitos (com 9) e 12 dígitos (sem 9) podem ser **pessoas diferentes**. Quando as duas variantes existem, o resultado é `AMBIGUOUS` e a decisão é humana: consulte os candidatos no evento e, se decidir, grave manualmente.
- Gate antes de **cada** consulta, só por **volume** (orçamento de validação): consultas são silenciosas e por design **ignoram as quiet hours** (cabeçalho de `validate.ts`); só os envios respeitam o horário de silêncio. Com o rate limit cheio, o lote **para** (leads restantes ficam intactos); o job assíncrono e a campanha dormem até a janela liberar e continuam sozinhos.
- Jitter aleatório entre consultas consecutivas. Lote máximo por rodada: 20 (`config.ts`).

Com os limites default, um lote de 20 leva ~10 minutos e o teto é 20 consultas/hora. É lento **de propósito**.

## 3. Leads validados como contatos

```bash
bun run wa:contacts --search 1          # via segura (default): registro CRM local
bun run wa:contacts --search 1 --push   # opcional: também salva na agenda in-app
```

Duas vias, ambas portadas do squad:

- **(a) Registro CRM (default, recomendado)** — o lead vira uma entidade em `wa_entities` (`data/whatsapp.db`) com o JID canônico. Um JID é endereçável diretamente no WhatsApp: dá para abrir conversa e mensagear sem salvar contato na agenda. **Zero interação com o servidor, zero superfície de ban** — por isso é o default e roda a qualquer hora. Idempotente.
- **(b) Agenda in-app (`--push`)** — usa `addOrEditContact(jid, {fullName, firstName, saveOnPrimaryAddressbook: true})` do Baileys para gravar o contato na agenda da conta (app-state sync); o lead aparece com nome na lista de contatos do aparelho. Como **toca a conta**, cada push passa pelo gate anti-ban (quiet hours + rate limit) com jitter, igual às consultas. Nunca re-push: `pushed_at` fica nos atributos da entidade.

Nos dois casos o lead ganha um `lead_events` `whatsapp_contact_added` (`{via:"crm"}` ou `{via:"addressbook"}`) no banco do core — é assim que o sistema sabe quais leads já viraram contato (`GET /api/leads/:id` mostra a trilha).

## 4. Backend HTTP multi-instância + mensageria (fase wa-backend)

O módulo expõe um backend HTTP sob `/api/wa/*`, montado cirurgicamente no `src/server.ts` do core (uma importação + um bloco de dispatch — `handleWaRequest(req, url)`). Ele suporta **múltiplas instâncias** (contas) simultâneas: cada instância é um socket Baileys independente, com auth próprio (`auth_state` com categorias prefixadas `i:<id>:`) e espelho SQLite filtrado por `instance_id` (tabelas `instances`, `chats`, `messages`, `contacts` em `data/whatsapp.db`, migração 2). A instância ativa (para envio) fica em `runtime_state.active_instance` e persiste entre reloads.

### Rotas

| Método | Rota | Efeito |
|---|---|---|
| POST | `/api/wa/instances` | Cria instância, inicia conexão, começa a emitir QR. `{id}` |
| GET | `/api/wa/instances` | Lista `[{id, name, phone, status, status_reason, is_active}]` (`status_reason`: motivo em PT-BR de um fechamento terminal, ou `null`) |
| GET | `/api/wa/instances/:id/qr` | QR atual como **data URL PNG** + expiração |
| POST | `/api/wa/instances/:id/select` | Define a instância ativa (persiste) |
| POST | `/api/wa/instances/:id/disconnect` | Encerra o socket, **preserva** a sessão |
| POST | `/api/wa/instances/:id/reconnect` | Reabre a partir da sessão salva (sem QR novo quando válida) |
| POST | `/api/wa/instances/:id/repair` | QR novo para conta EXISTENTE: zera SÓ o auth dessa instância, **preserva** chats/contacts → emite QR |
| DELETE | `/api/wa/instances/:id` | Logout (Baileys) + limpa o auth dessa instância (próxima conexão exige QR novo) |
| GET | `/api/wa/chats?instance=:id` | Conversas do espelho `[{jid, name, phone, last_message, last_type, last_ts, unread, saved}]` (`phone`: número real quando conhecido, inclusive em chats `@lid`) |
| GET | `/api/wa/chats/:jid/messages?instance=:id` | Mensagens `[{id, from_me, text, type, ts, status, media, quoted, reactions}]` paginadas (`before`/`before_id`/`limit`) + `has_more`/`fetching` (lazy-load). Ver seção 8 |
| POST | `/api/wa/send` `{instance, jid, text?, media_id?, caption?, voice?}` | Envia texto ou mídia **pelo gate**; grava a mensagem (e a mídia) no espelho. 429 = rate limit; 409 = quiet hours (sem mensagem recebida no chat) ou instância desconectada |
| GET | `/api/wa/messages/media?instance=&chat=&id=&from_me=` | Baixa a mídia sob demanda (cache em disco) com Range. Ver seção 8 |
| GET | `/api/wa/messages/thumbnail?instance=&chat=&id=&from_me=` | Miniatura JPEG guardada na ingestão |
| GET | `/api/wa/leads` | Leads `is_whatsapp=1` como contatos iniciáveis `[{lead_id, name, phone, jid, category}]` |
| POST | `/api/wa/validate` | `{instance, lead_ids[]}` → job assíncrono de validação (onWhatsApp pelo gate), `{job_id}`. Sem conexão → 409; já há validação rodando nessa instância → 409 (`job_id` do job em curso) |
| GET | `/api/wa/validate/:job` | `{status, total, checked, is_whatsapp, not_whatsapp, ambiguous, failed, results[]}` (+ evento `validate` no stream) |
| POST | `/api/wa/validate/:job/resume` | Retoma um job pausado. 409 se o job já está rodando, já terminou, ou sem conexão |
| GET | `/api/wa/stream` | SSE: eventos `qr`, `status`, `message`, `message_status`, `reaction` para a UI atualizar ao vivo |

`status` de conexão: `connecting` → `qr` → `connected`; `disconnected` (socket fechado, sessão preservada); `logged_out` (após DELETE ou sessão desconectada no celular). Fechamentos terminais não reconectam sozinhos e explicam o motivo em `status_reason` (também no evento SSE `status`, campo `reason`): 440 sessão substituída, 403 acesso negado, 411 multi-dispositivo, 401 desconectado no celular (auth apagado → novo QR), QR expirado 5 vezes sem leitura (clique em reconectar). 500 (sessão corrompida) apaga o auth e reconecta → QR. **Reconexão no boot:** ao subir o servidor (`initWaBackend`, chamado em `src/server.ts`), toda instância **pareada** (credenciais salvas) é reaberta sozinha, uma por segundo. Nunca abre socket (QR) para instância não pareada. Ficam de fora as que fecharam de forma terminal (440, 403, 411, 401, QR esgotado) ou que foram desconectadas manualmente; o motivo fica persistido em `runtime_state` (`autostart_block@<id>`), aparece em `status_reason` mesmo após reiniciar e é limpo quando a conexão abre de novo (ex.: depois de "Reconectar"). Em testes, `createWaRouter` não reconecta nada a menos que receba `autoStart`. O QR **rotaciona** (~20–60s): a UI faz polling em `/qr` ou consome o `stream` (evento `qr` com nova imagem). O status do QR expira em ~60s (`expires_at`, epoch ms).

O contrato JSON completo (shapes exatos) está em `outputs/<trace>/squads/agentic-whatsapp-nirvana/outputs/_SUMMARY.md` — fonte de verdade para a fase `wa-ui`.

### Histórico é parcial por protocolo

O WhatsApp multi-device **não sincroniza todo o histórico antigo**. A thread mostra o que chega a partir da conexão + o que é enviado por aqui. Deixe isso claro num empty state na UI ("Conversas aparecem a partir da conexão"). Mídia: ver seção 8 (grupos continuam fora de escopo).

## 5. Campanha de disparo em massa personalizado (fase campaign-backend)

Disparo personalizado a partir dos leads selecionados no grid, sob `/api/wa/*` (mount já cobre; sem mudança no `src/server.ts`):

| Método | Rota | Efeito |
|---|---|---|
| POST | `/api/wa/media` | Upload de UMA mídia (`multipart`, campo `file`, ≤100 MB; `Content-Length` acima disso → 413 antes de ler o corpo; depois do sniff, limite por tipo: imagem 16 MB, vídeo 64 MB, áudio 16 MB, documento 100 MB) → `{media_id, kind, mime, filename, size}`. Tipo detectado pelos **bytes mágicos** (JPEG, PNG, WEBP, GIF, MP4, M4A, PDF, OGG, MP3, ZIP; ZIP com extensão docx/xlsx/pptx recebe o mime do Office; áudio fica `kind: "document"` para a campanha), nunca pelo `file.type` do cliente; desconhecido → 415. O mesmo `media_id` serve para `POST /api/wa/send` |
| POST | `/api/wa/campaign` | `{instance, lead_ids[], template, media?}` → cria job assíncrono, `{job_id}`. Placeholder desconhecido → 400 (`unknown_placeholders`, `valid_placeholders`); sem conexão → 409; já há campanha rodando nessa instância → 409 |
| GET | `/api/wa/campaign/:job` | Status agregado + por destinatário (`reason`: motivo da pausa/falha, ex.: `servidor reiniciado`, `instância não conectada`, quiet hours) |
| POST | `/api/wa/campaign/:job/resume` | Retoma uma campanha pausada (ou que falhou) sobre os destinatários ainda `queued` → `{ok, job_id}`. 409 (PT-BR em `error`) se ela já está rodando, já terminou, a conta dela não está conectada, há outra campanha ou uma validação rodando nessa conta (`job_id` do job em curso), ou se é horário de silêncio |
| GET | `/api/wa/stream` | evento `campaign` (agregado + destinatário que mudou) |

O runner (`campaign.ts`) processa só destinatários `queued`: valida pendentes (`is_whatsapp` null) com `validateUntilDone` (orçamento de validação; espera a janela liberar em vez de desistir) → pula não-WhatsApp (`skipped:not_whatsapp`) → pula o mesmo JID de outro lead da campanha (`mesmo WhatsApp de outro lead desta campanha`) e JID que recebeu mensagem de outra campanha nos últimos 7 dias → substitui `{{coluna}}` por linha (name, category, address, phone, website, rating, email; case-insensitive; texto vazio sem mídia → `skipped:empty_message`; placeholder usado e vazio para o lead → `skipped` com `campo vazio para este lead: {{x}}`) → envia pelo **gate** (espaçamento ≥ 60s ÷ max_per_minute, mais jitter; quiet hours + rate limit **integrais**). Com mídia, o texto substituído vai como **caption** (image/video/document). Rate limit cheio → dorme até a janela liberar e **continua sozinho**; quiet hours ou socket perdido → destinatário `queued` + campanha `paused` com o motivo (nunca força). Erro inesperado → `failed` com o motivo. Ao subir o servidor, campanhas e validações que ficaram `queued`/`running` de um processo anterior viram `paused` (`servidor reiniciado`).

**Retomar** (`POST /api/wa/campaign/:job/resume`) relança o mesmo runner: ele só percorre destinatários `queued` e nunca reenvia (JIDs já `sent` na campanha são pulados). Dentro das quiet hours a retomada é recusada com 409 em vez de deixar o runner esperar, porque o runner **não espera** quiet hours: no primeiro envio bloqueado ele pausa de novo. Retome depois das 08h. Na UI, a campanha pausada mostra o motivo vindo do backend e o botão "Retomar".

Contrato JSON completo (shapes, upload, placeholders) em `outputs/<trace>/squads/agentic-whatsapp-nirvana/outputs/_SUMMARY.md` — fonte de verdade da fase `campaign-ui`.

Aviso honesto: cold outreach a quem nunca escreveu tem risco real de ToS/ban e sensibilidade LGPD. Número dedicado, ritmo baixo, confirmação humana antes de disparar.

## 6. Qualidade da tela + salvar contato (fase wa-quality-backend)

Correções de apresentação e salvamento de contato (só `src/whatsapp/**`):

- **Nome resolvido** em `GET /api/wa/chats`: LEFT JOIN `contacts` e coalesce `chats.name → display_name → notify_name → verified_name → número`. Campos novos: `last_type` e `saved` (bool = `display_name IS NOT NULL`). A prévia (`last_message`/`last_type`) ignora mensagens de sistema.
- **Tipo exposto** em `GET /api/wa/chats/:jid/messages`: campo `type` por mensagem; `protocolMessage`, `senderKeyDistributionMessage` e `reactionMessage` são **excluídos** (eram o "mensagem não textual"). Mídia permanece com o `type` para a UI rotular.
- **Schema** (migração 4, aditiva): coluna `verified_name` em `contacts`. `upsertContact` grava `display_name`=nome da agenda, `notify_name`=pushName, `verified_name`=nome verificado — separados (antes colapsava). "Salvo na agenda" ⇔ `display_name IS NOT NULL`.
- **Salvar contato:** `POST /api/wa/contacts/save {instance, jids[]}` (individual e massa). Já salvo → `skipped_already_saved` (sem tocar Baileys); não salvo → `addOrEditContact` **pelo gate** → `saved`; falha → `failed`. Nome: lead (por `whatsapp_jid`) → notify → número. `GET /api/wa/contacts/status?instance=&jids=a,b` consulta "já salvo?" em lote. Sem envio de mensagem aqui.

Contrato completo (campos, rótulos de tipo, como a UI lê "saved") em `outputs/<trace>/squads/agentic-whatsapp-nirvana/outputs/_SUMMARY.md` — fonte de verdade da fase `wa-quality-ui`.

## 7. Endurecimento (fase hardening)

- **Sem CORS:** a API é same-origin (a UI vem do próprio `src/server.ts`); nenhum `Access-Control-Allow-*`. Todo POST com corpo JSON exige `Content-Type: application/json` (senão 415) — barra POST "simples" vindo de outro site.
- **Conexão:** nenhum erro no handler de eventos derruba o processo (cada encaminhamento é isolado e logado); falha ao abrir o socket agenda nova tentativa. Callbacks de um socket antigo (substituído ou removido) são ignorados por contador de geração — não ressuscitam instância apagada nem derrubam a conexão nova.
- **Banco:** `busy_timeout=5000`; cada migração roda em `BEGIN IMMEDIATE` relendo `user_version` (dois processos não aplicam a mesma migração duas vezes). Migração 6: mensagens de grupo que ficaram com tipo `senderKeyDistributionMessage` e têm texto viram `conversation` (o payload bruto não é guardado, então as sem texto continuam ocultas); índices por `kind` em `wa_actions` e por `jid` em `campaign_recipients`.
- **Espelho:** o tipo da mensagem ignora `senderKeyDistributionMessage`/`messageContextInfo`; reentrega preenche tipo/texto que faltavam (`coalesce`); edição atualiza a mensagem original; status 0 → `error`, 5 → `played`; o evento SSE `message` traz `type`. Chats `@lid` guardam o número real em `contacts.phone_number` quando o Baileys o informa (`remoteJidAlt`, `participantAlt`, `phoneNumber`). A unificação completa LID↔telefone dos chats fica para depois.
- **Instâncias:** apagar uma instância também apaga suas chaves em `runtime_state`.
- **Telefones:** `+` ou `00` com DDI ≠ 55 fica internacional (sem prefixar 55); 0300/0500/0800/0900 e linhas 3003/4003/4004 são rejeitados (não são celulares).

## 8. Mídia, respostas e reações (fase wa-media)

**Ingestão (ao vivo e history sync).** Para mensagens de imagem, vídeo (inclusive `ptvMessage`), áudio (inclusive nota de voz `ptt`), documento (inclusive `documentWithCaptionMessage`) e figurinha, `ingestMessage` grava uma linha em `message_media` (migração 7, aditiva e idempotente), com a mesma chave de `messages`:

- metadados: `kind` (`image | video | audio | voice | document | sticker`), `mimetype`, `file_name`, `file_size`, `duration_s`, `width`, `height`;
- `raw_json`: o WAMessage mínimo `{key, message: {<tipo>: nó}, messageTimestamp}` serializado com `BufferJSON` do Baileys, só com os campos que `downloadMediaMessage`/`updateMediaMessage` precisam (`url`, `directPath`, `mediaKey`, `fileEncSha256`, `fileSha256`, `mimetype`, `fileLength`, `fileName`, `seconds`, `ptt`, `width`, `height`, `caption`…). `contextInfo` e a miniatura ficam de fora; acima de 32 KB não é guardado. Sem `mediaKey` + `directPath`/`url`, fica `NULL` (não baixável);
- `thumbnail_b64`: o `jpegThumbnail` em base64 (até 96 KB), para prévia instantânea;
- `cache_path`/`cache_sha256`: o arquivo baixado (ou enviado por aqui).

Também ficam guardados o contexto de resposta (`messages.quoted_id/quoted_text/quoted_type`, a partir de `contextInfo.stanzaId`) e as reações (`message_reactions`: a última reação de cada pessoa por mensagem; emoji vazio remove). Mensagens recebidas **antes** desta atualização não têm nada disso (o payload bruto nunca foi guardado).

**Lista de mensagens** (`GET /api/wa/chats/:jid/messages`): cada item ganha

```json
{
  "id": "3EB0...", "from_me": false, "text": "Segue a proposta", "type": "documentMessage", "ts": 1760000000, "status": null,
  "media": { "kind": "document", "mimetype": "application/pdf", "file_name": "Proposta.pdf", "file_size": 182311,
             "duration_s": null, "width": null, "height": null, "has_thumbnail": true, "available": true, "cached": false },
  "quoted": { "id": "3EB0AB...", "text": "Pode mandar a proposta?", "type": "conversation" },
  "reactions": [ { "emoji": "👍", "from_me": true } ]
}
```

`media` é `null` em mensagens sem mídia. `available: false` = chaves nunca guardadas (mensagem antiga): mostre "Mídia indisponível (recebida antes da atualização)". `cached: true` = o arquivo já está em `data/wa-media` (o servidor confere se o arquivo existe); só nesse caso a interface exibe a mídia sem perguntar. Legenda continua em `text`. `quoted` é `null` quando não é resposta. Linhas `reactionMessage` não viram bolha: aparecem em `reactions` da mensagem-alvo.

**SSE**: o evento `message` traz `media` e `quoted` com o mesmo shape. Reações chegam como evento próprio `reaction`: `{instance, chat_jid, target_id, emoji, from_me, removed}` (`removed: true` quando o emoji é vazio).

**Tiques de entrega ao vivo**: cada `messages.update` do Baileys com status grava `messages.status` (`handleMessagesUpdate` em `ingestion.ts`) e, para cada linha espelhada que mudou, o manager publica o evento `message_status`: `{instance, chat_jid, message_id, from_me, status}`, com `status` em `pending | sent | delivered | read | played | error`. Atualização de mensagem que não está no espelho não gera evento. A interface troca o tique da bolha correspondente sem recarregar a conversa.

**Download** — `GET /api/wa/messages/media?instance=<id>&chat=<jid>&id=<message_id>&from_me=<0|1>`:

- arquivo já em cache → serve na hora (mesmo com a conta desconectada);
- senão baixa com `downloadMediaMessage` (stream), com `reuploadRequest: sock.updateMediaMessage` quando a URL expirou (404/410). As chaves renovadas são persistidas. Grava em `data/wa-media/in/<instance>/<sha256>.<ext>`. Downloads simultâneos da mesma mídia compartilham uma única transferência;
- resposta: `Content-Type` (mimetype da mensagem), `Content-Length`, `Accept-Ranges: bytes`, `Content-Disposition: inline` (imagem, vídeo, áudio, voz, figurinha) ou `attachment; filename="<ascii>"; filename*=UTF-8''<nome codificado>` (documento, RFC 5987), `Cache-Control: private, max-age=86400`, `Cross-Origin-Resource-Policy: same-origin`;
- `Range: bytes=a-b`, `a-` ou `-n` → `206` com `Content-Range`; fora do arquivo → `416` (`Content-Range: bytes */<tamanho>`);
- erros (JSON `{error, code}`): `404 media_unavailable` "Mídia indisponível (recebida antes da atualização)."; `404 message_not_found`; `404 not_media`; `409 not_connected` (sem socket conectado e sem cache); `413 too_large` (acima de 100 MB); `502 download_failed`; `400` parâmetros faltando.

**Nada baixa por padrão (regra de produto).** Abrir uma conversa não baixa nenhum arquivo. Cada bolha de mídia não baixada mostra tipo, tamanho, a miniatura guardada (quando existe) e um botão "Baixar"; mídia já em cache (inclusive tudo o que você envia por aqui) aparece normalmente. Para baixar em lote, a interface usa:

- `GET /api/wa/chats/:jid/media-summary?instance=` → `{total, cached, downloadable, unavailable, downloadable_bytes, unknown_size_count, cached_bytes}` (`media-jobs.ts`, mesmas regras de `mediaView`);
- `POST /api/wa/chats/:jid/media/download {instance}` → `202 {job_id}`: baixa toda mídia baixável da conversa, 2 por vez, por `ensureMediaCached` (o mesmo caminho do download avulso: cache, transferências compartilhadas, reupload em 403/404/410, fallback de DNS); acima de 100 MB vira erro `too_large` sem transferir. Um job por conversa (`409 job_running` com o `job_id` em andamento); sem socket conectado, `409 not_connected`. Progresso em `GET /api/wa/media-jobs/:id` → `{status: running|done|failed, total, done, failed, bytes, errors: [{message_id, code}]}`; o registro é em memória (some no reinício do servidor; os arquivos já baixados ficam).
- `POST /api/wa/chats/:jid/media/recover {instance}` → `{requested, recovered, still_unavailable}`: para mídia sem chaves, pede ao celular o histórico da conversa com `fetchMessageHistory` (history sync `ON_DEMAND`), 50 mensagens por pedido, ancorado na mensagem **mais recente** e depois na mais antiga de cada lote recebido, até cobrir a mídia indisponível mais antiga, o celular parar de responder, 6 pedidos ou 45 s. O `oldestMsgTimestampMs` vai em milissegundos. As mensagens reentregues passam por `ingestMessage`, que grava `message_media` mesmo quando a mensagem já existe em `messages` (o `ON CONFLICT` de `messages` não pula a mídia; o de `message_media` usa `coalesce` e nunca apaga chaves). Uma mensagem antiga reingerida não troca a prévia da conversa (`ensureChat` só atualiza `last_message_text` com mensagem igual ou mais nova). Uma recuperação por conversa por vez (`409 recover_running`). Não há garantia: o WhatsApp pode não reenviar mensagens já sincronizadas, e o resultado diz quantas voltaram (`recovered`).

Miniatura: `GET /api/wa/messages/thumbnail?<mesmos parâmetros>` → `image/jpeg` (o `jpegThumbnail` guardado) ou `404 no_thumbnail`. Escolhi endpoint separado em vez de data URL na lista: a lista fica leve (200 mensagens × miniatura pesariam ~1 MB) e o navegador busca só as miniaturas visíveis (`<img loading="lazy">`).

**Envio de mídia** — `POST /api/wa/send {instance, jid, media_id, caption?, voice?}` (o `media_id` vem de `POST /api/wa/media`). `text` também vale como legenda quando `caption` não vem. Regras:

- `audio/*` vai como áudio; com `voice: true` e arquivo OGG (Opus) vai como nota de voz (`ptt: true`, mimetype `audio/ogg; codecs=opus`). `voice: true` com outro formato → 400. Áudio não aceita legenda → 400. Imagem/vídeo vão com legenda; o resto vai como documento com o nome original;
- limites do WhatsApp (constantes em `media.ts`): imagem 16 MB, vídeo 64 MB, áudio 16 MB, documento 100 MB → 413;
- mesmo gate do texto (rate limit; quiet hours afrouxadas só para resposta); tudo é validado **antes** de reservar a vaga no gate;
- a mensagem enviada é espelhada com a sua linha em `message_media` (chaves que o Baileys devolve) e o arquivo enviado vira o cache, então `GET .../media` serve na hora. Resposta `{ok: true, message: {chat_jid, message_id, from_me, text, type, ts, status, media, quoted}}`.

## Uso programático (para o core)

```ts
import { validateLeads, registerLeadContacts } from "./src/whatsapp/index.ts";

const report = await validateLeads([1, 2, 3]);
// { validated, ambiguous, skipped, failed, stopped_reason, details }

await registerLeadContacts([1, 2], { push: false });
```

`validateLeads` cumpre o contrato original deste README (campos `validated/ambiguous/skipped`, com extras `failed/stopped_reason/details`). Exige sessão pareada; sem ela lança `NotPairedError` com instrução clara. O shape de rota REST sugerido está em `outputs/_NOTES.md` do trace — `src/server.ts` não foi tocado.

## Arquivos

| Arquivo | Papel |
|---|---|
| `config.ts` | Política anti-ban (rate limit, jitter, quiet hours, lote) |
| `db.ts` | `data/whatsapp.db` (migrações idempotentes) |
| `auth-state.ts` | Sessão Baileys em SQLite (porte do squad) |
| `resolver.ts` | Nono dígito BR + `onWhatsApp` seguro (porte do squad) |
| `gate.ts` | Gate anti-ban (porte adaptado do squad) |
| `connection.ts` | Socket Baileys: versão real do WA Web, reconexão, multi-instância (`instanceId`), forwards de eventos, `connectAndWaitOpen` |
| `instances.ts` | Registro de instâncias + instância ativa persistida |
| `ingestion.ts` | Eventos Baileys → espelho (`chats`/`messages`/`contacts`, mídia, respostas, reações), por instância |
| `media.ts` | Mídia: extração na ingestão, `message_media`, download com cache + reupload, serviço HTTP com Range, limites |
| `media-jobs.ts` | Mídia por conversa: resumo (`cached`/`downloadable`/`unavailable`) e job de download em lote |
| `manager.ts` | Runtime multi-instância: sockets vivos, QR→data URL, barramento SSE, envio pelo gate |
| `routes.ts` | Router HTTP `/api/wa/*` (`handleWaRequest`) + helpers SSE (`formatSse`/`parseSseStream`) |
| `validate.ts` | `validateLeads` (contrato do core) |
| `contacts.ts` | Registro CRM + push de agenda |
| `scripts/pair.ts` · `scripts/validate.ts` · `scripts/contacts.ts` | CLIs `wa:pair` · `wa:validate` · `wa:contacts` |
| `tests/*.test.ts` | Testes com socket e downloader falsos (sem rede) — `bun test src/whatsapp` |
