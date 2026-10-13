# prospecteezy: interface web (src/client)

React 19 + TypeScript + Tailwind CSS 4 + shadcn/ui, empacotado pelo próprio Bun
(HTML import no `Bun.serve`). Não há Vite, Next.js nem etapa de build: o usuário
roda `bun install` e `bun run start`, e o Bun empacota a interface na primeira
requisição (em produção, minificado e com cache; em desenvolvimento, com HMR).

Texto da interface em PT-BR (UTF-8, com acentos). Identificadores e comentários
em inglês.

## Como rodar

| Comando | O que faz |
|---|---|
| `bun run start` | App completo em http://localhost:3000 (servidor + interface, bundle minificado). |
| `bun run dev` | Mesmo app com `NODE_ENV=development`: HMR na interface (editar `src/client` recarrega no navegador sem reiniciar o processo) e `--watch` no servidor (editar o backend reinicia o processo e reconecta o WhatsApp). |
| `bun run dev:ui` | Preview em http://localhost:3090 com HMR. Encaminha `/api/*` para o backend em :3000 **só para GET/HEAD**. Escritas recebem 503 "Bloqueado no preview", porque o backend tem leads reais e um WhatsApp ao vivo. `PREVIEW_ALLOW_WRITES=1` libera (por sua conta e risco). |
| `bun run dev:ui:mock` | Mesmo preview com um backend **falso em memória** (`dev/mock-backend.ts`): leads, buscas (esgotamento de 24 h: a busca 2 já vem esgotada; cidades com "Vazia" esgotam na hora), enriquecimento, validação (com uma pausa para testar "Retomar"), Configurações e provedores de IA. Use para testar fluxos de escrita. |
| `bun test src/client` | Testes de lógica do cliente (`tests/`). |
| `bunx tsc --noEmit` | Typecheck do projeto inteiro (backend + cliente, um só `tsconfig.json`). |

Variáveis do preview: `PREVIEW_PORT` (3090), `PREVIEW_BACKEND` (http://localhost:3000),
`PREVIEW_MOCK=1`, `PREVIEW_ALLOW_WRITES=1`. O proxy reescreve `Host` e `Origin`
para os do backend (o guard de mesma origem do servidor recusa os de outra porta).

## Arquitetura

```
src/client/
  index.html            entrada (HTML import); aplica o tema antes do primeiro paint
  main.tsx              monta <App/>
  routes.ts             rotas da SPA + APP_PATHS (sem React; o servidor importa)
  preview.ts            servidor de preview (proxy só leitura ou mock)
  app/
    app.tsx             shell: header + view da rota + painel do assistente + dock de jobs
    providers.tsx       pilha de providers (tema, Query, tooltip, confirm, SSE, assistente…)
    router.tsx          roteador mínimo (history API): useRoute, navigate, <Link>
  components/
    ui/                 componentes shadcn (gerados pelo CLI; ajustes pequenos: PT-BR,
                        checkbox indeterminado, rótulos dos thumbs do slider, sonner sem next-themes)
    app-shell/          header, abas, alternância de tema
    common/             useConfirm, StepList, EmptyState, StatusBadge, TagBadge/TagList, TagInput
    theme/              ThemeProvider (claro/escuro/sistema)
  features/
    leads/              view de Leads: métricas, painel "Buscas" (histórico com status,
                        "Ver leads", "Buscar mais", "Outra cidade"), tabela, filtros, seleção, drawer do lead
      jobs/             validação de WhatsApp e enriquecimento (estado global + dock de progresso)
    assistant/          painel lateral; chat clássico (POST /api/prospect + progresso)
    ai/                 chat com IA: provider, painel, renderizadores de ferramentas
    whatsapp/           contas e QR, conversas, compositor, campanhas;
                        wa-stream.tsx (SSE compartilhado) e indicador de conexão
    settings/           Serper, perfil da empresa, provedores de IA
  lib/
    api/client.ts       fetch tipado (ApiError, mensagens PT-BR, JSON em toda escrita)
    api/endpoints.ts    uma função por rota REST
    api/types.ts        shapes do backend (espelhados à mão de docs/api.md)
    queries.ts          chaves e hooks do TanStack Query
    format.ts csv.ts lead-filters.ts tags.ts   utilitários puros (testados)
    utils.ts            cn()
  styles/globals.css    Tailwind 4 + tokens de tema (CSS variables)
  dev/                 backend falso do preview: mock-backend.ts, mock-whatsapp.ts,
                        mock-ai-chat.ts (nunca entram no bundle do app)
  tests/                bun test
```

### Rotas

Roteamento por history API: `/leads`, `/whatsapp`, `/configuracoes` (`/` redireciona
para `/leads`). O servidor precisa devolver `index.html` em cada caminho de
`APP_PATHS` (lista explícita; nunca um `"/*"`, que engoliria `/api/wa/*`).

### Dados (TanStack Query)

- Nunca use `fetch` direto numa view: adicione a função em `lib/api/endpoints.ts`
  e um hook em `lib/queries.ts` (ou `useQuery` com uma chave de `qk`).
- `request()` sempre manda `Content-Type: application/json` e corpo JSON (padrão `{}`)
  em POST/PUT/PATCH/DELETE: várias rotas respondem 415 sem isso.
- Erros viram `ApiError` com `message` em PT-BR (vinda de `{ error }`); use
  `errorMessage(error, "fallback")` na UI.
- Invalidação por prefixo: `queryClient.invalidateQueries({ queryKey: qk.leads.root })`
  atualiza tabela, métricas e drawer. Mudou IA? `qk.ai.root` (o painel e o drawer
  reagem na hora).
- Jobs com polling (`refetchInterval`) usam `refetchIntervalInBackground: true`.

### Estado global (contextos)

| Hook | Para quê |
|---|---|
| `useLeadsState()` | busca, filtros, ordenação, página, seleção entre páginas, ambíguos da sessão, densidade, lead aberto |
| `useLeadJobs()` | iniciar/acompanhar validação e enriquecimento (`validate.start(ids)`, `enrich.start(ids)`) |
| `useAssistant()` | abrir o painel, `openWithPrompt(texto)`, `pendingPrompt`/`consumePrompt()` |
| `useProspectChat()` | histórico do chat clássico, `submit(texto, tags?)`, `trackJob(jobId)` |
| `useWaStream()` / `useWaStreamEvent(nome, fn)` | uma única conexão SSE em `/api/wa/stream` para o app inteiro |
| `useConfirm()` | `await confirm({ title, description, confirmLabel, destructive })` |
| `useTheme()` | `preference` (light/dark/system), `resolved`, `setPreference` |

## Como adicionar uma view

1. Crie `features/<nome>/<nome>-view.tsx` exportando um componente.
2. Registre o caminho em `routes.ts` (`ROUTES`) → entra em `APP_PATHS` sozinho.
3. Adicione em `VIEWS` e `TITLES` (`app/app.tsx`) e em `NAV` (`components/app-shell/app-header.tsx`).
4. Se o servidor usa a lista `APP_PATHS`, nada a mudar no backend.

## WhatsApp (`features/whatsapp`)

- `whatsapp-view.tsx`: barra da conta ativa, mensageiro em dois painéis (lista de conversas + conversa; abaixo de `md` vira navegação lista → conversa) e campanhas.
- `accounts.tsx`: contas (instâncias) com status e motivo, conta ativa, parear número novo por QR, reconectar, reparar (novo QR mantendo as conversas), desconectar e remover.
- `chat-list.tsx`: conversas ou leads validados para iniciar uma, busca, prévia da última mensagem, não lidas, contatos salvos, navegação por teclado e "salvar contatos" em lote.
- `chat-thread.tsx` + `use-chat-thread.ts`: conversa com rolagem infinita para cima (o backend busca histórico antigo no WhatsApp quando o espelho acaba), envio otimista substituído pelo eco do servidor e atualizações ao vivo pelo SSE: `message` (nova ou editada), `message_status` (tique da bolha: enviado, entregue, lido, reproduzido, erro) e `reaction`.
- `composer.tsx`: texto (Enter envia, Shift+Enter quebra linha), anexos (botão, arrastar e soltar, colar imagem) enviados para `POST /api/wa/media` com progresso, nota de voz só onde o navegador grava OGG/Opus.
- `message-bubble.tsx` / `message-media.tsx`: resposta citada, mídia sob demanda (`/api/wa/messages/media` e `/thumbnail`), formatação do WhatsApp renderizada como nós React (nunca HTML), hora + tiques, reações. Nada baixa sozinho: só mídia com `cached: true` aparece direto; o resto mostra miniatura (se houver) ou ícone, tamanho e "Baixar" (imagem aparece, áudio e vídeo começam a tocar, documento é salvo).
- `media-load-dialog.tsx`: botão "Carregar arquivos" no topo da conversa; resumo (`media-summary`) com aviso de espaço em disco, opção de recuperar arquivos antigos pedindo o histórico ao celular (`media/recover`), job de download com progresso (`media/download` + `media-jobs/:id`) e resultado final. O estado do fluxo fica no botão, então fechar o diálogo não interrompe o download. Transições em `mediaLoadReducer` (`wa-utils.ts`, testado em `tests/whatsapp-media-load.test.ts`).
- `campaign-composer.tsx`: props `{ open, onOpenChange, leadIds }` (a barra de seleção de Leads abre com os ids selecionados); modelo com `{{variáveis}}`, prévia com um lead real, mídia opcional, consentimento, progresso por polling + SSE `campaign`, motivo da pausa e "Retomar". `campaign-store.ts` lembra a última campanha deste navegador.
- Assine eventos com `useWaStreamEvent("status" | "qr" | "message" | "message_status" | "reaction" | "campaign" | "validate", fn)`; nunca abra outro `EventSource`.
- Lógica pura em `wa-utils.ts` (testada em `tests/whatsapp.test.ts`). Contrato do backend: `src/whatsapp/README.md` e `docs/api.md`.

## Chat com IA (`features/ai`)

A IA é opcional: sem provedor ativo (Configurações → Inteligência artificial), `POST /api/chat` responde 409 e o painel do assistente mostra o chat clássico (`POST /api/prospect`).

- `ai-chat-provider.tsx`: o `Chat` do `@ai-sdk/react` vive no nível do app (`useAiChat()`), então a resposta em andamento, o texto do campo e a conversa aberta sobrevivem ao fechar o painel. Transporte `DefaultChatTransport` em `/api/chat` mandando só a última mensagem; `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses`; id da conversa em `localStorage["prospecteezy-ai-chat-id"]`. Também consome `pendingPrompt` (botões "Pesquisar com IA" / "Redigir mensagem" do drawer do lead).
- `ai-chat-slot.tsx` (view), `message-view.tsx`, `tool-renderers.tsx` (um renderizador por ferramenta; desconhecidas caem no `<Tool>` genérico), `approval-card.tsx` (Aprovar/Recusar com custo estimado em créditos Serper), `draft-card.tsx` (rascunho editável; "Enviar pelo WhatsApp" também passa por aprovação), `job-progress.tsx` (reusa o `JobCard` do chat clássico), `chat-history.tsx`. Lógica pura em `chat-logic.ts` (testada em `tests/ai-chat.test.ts`).
- Aprovação fora da última mensagem = "Recusado (nova mensagem)" (o servidor já recusou). 400 ao reenviar uma aprovação: o cartão vira resolvido e a conversa é recarregada do servidor.
- `components/ai-elements/`: instalados pelo CLI com ajustes locais: PT-BR, `streamdown-safety.ts` (links só http(s)/mailto/tel, sem plugins pesados do Streamdown), `tool.tsx` sem shiki. `globals.css` tem `@source` do Streamdown.
- Mock: `dev/mock-ai-chat.ts` gera o stream real do AI SDK v7 com respostas roteirizadas (veja o cabeçalho do arquivo). No mock a IA começa desligada: ative um provedor em Configurações.

## Tags

- Identidade pelo slug (minúsculas, sem acento), igual ao backend: `lib/tags.ts` (`tagSlug`, `addTag`, `matchesTags`, `tagSuggestions`, paleta `TAG_PALETTE` escolhida pelo slug, contraste AA no claro e no escuro).
- `TagInput` (combobox com chips, autocompletar de `GET /api/tags`, Enter/vírgula cria, Backspace remove a última) e `TagBadge`/`TagList` (2 primeiras + "+N" com tooltip).
- Onde aparecem: barra de seleção ("Tags": adicionar/remover em massa), filtros (tags com contagem + "Qualquer uma/Todas", chips "Tag: X"), coluna da tabela (≥ lg) e cartões no celular, drawer do lead (salva na hora), painel Buscas (tags da busca, edição, campos em "Buscar mais" e "Outra cidade"), chat clássico ("Tags" opcional), CSV (coluna `tags`).
- Só tags no filtro: o servidor filtra (`tags`, `tags_mode`). Com outros filtros avançados, tudo roda no cliente sobre a lista completa (as linhas já trazem `tags`).
- `qk.tags` fica sob o prefixo `leads`: invalidar `qk.leads.root` atualiza contagens.

## Tema e estilo

- Tokens em `styles/globals.css` (`:root` claro, `.dark` escuro), expostos ao Tailwind via
  `@theme inline`. Além dos do shadcn: `brand`, `success`, `warning`, `info`.
- Classe `dark` no `<html>`: `index.html` aplica antes do paint; `ThemeProvider` mantém.
  Preferência em `localStorage["prospecteezy-theme"]` (ausente = sistema).
- Ícones: `lucide-react`. Números: classe `tabular`. Estados: `StatusBadge` com `tone`.
- Acessibilidade: primitivas Radix (foco, teclado, Esc), rótulos em todo controle de ícone,
  `aria-live` nos progressos, link "Pular para o conteúdo", `prefers-reduced-motion` respeitado.
- Responsivo até 390 px: a tabela vira lista de cartões abaixo de `md`; a barra de seleção
  agrupa ações num menu abaixo de `xl`.

## Montagem no servidor

`src/server.ts` importa `./client/index.html` e registra cada caminho de `APP_PATHS`
em `routes`, fora do `guardRoutes` (que espera objetos de métodos):

```ts
development: Bun.env.NODE_ENV === "development" ? { hmr: true, console: true } : false,
routes: {
  ...Object.fromEntries(APP_PATHS.map((path) => [path, appIndex])),
  ...guardRoutes({ /* rotas /api */ }),
},
```

`/api/wa/*` continua no `fetch` de fallback, que também devolve 404 JSON para qualquer
outro caminho. Por isso nunca há um `"/*"`. Em produção (`bun run start`) o Bun gera o
bundle na primeira requisição e o mantém em memória; depois de atualizar o código,
reinicie o servidor e recarregue a página.
