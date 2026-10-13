# prospecteezy

Ferramenta de prospecção B2B que roda no seu computador. Você escreve um pedido em português, por exemplo "Busque 50 clínicas odontológicas em Curitiba-PR", e o sistema encontra as empresas no Google Maps, salva os contatos, procura e-mails nos sites delas e mostra tudo numa tela no navegador. Com um número de WhatsApp conectado, ele também verifica quais telefones têm WhatsApp, abre as conversas e envia campanhas com limites de segurança.

A inteligência artificial é opcional. Sem ela, tudo funciona por regras. Com ela, você ganha um assistente que entende pedidos livres, pesquisa leads na web e redige mensagens com base no perfil da sua empresa.

Tudo fica salvo localmente, na pasta `data/`. O sistema só aceita conexões do próprio computador.

---

## O que você precisa

1. Um computador com macOS, Linux ou Windows 10/11.
2. Uma conta no **Serper.dev**, o serviço que faz as buscas no Google. A conta nova vem com 2.500 consultas grátis.
3. (Opcional) Um celular com um número de WhatsApp **dedicado**, separado do seu número pessoal.
4. (Opcional) Uma chave de API de um provedor de IA: OpenAI, Google Gemini, Anthropic, OpenRouter ou qualquer serviço compatível com a API da OpenAI (Groq, DeepSeek, Ollama local e outros).

---

## Passo 1. Instalar o Bun

O prospecteezy roda com o **Bun**, instalado uma única vez.

**macOS ou Linux:** abra o app **Terminal** e cole:

```bash
curl -fsSL https://bun.sh/install | bash
```

**Windows:** abra o **PowerShell** e cole:

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

Depois, **feche o terminal e abra de novo**. Digite `bun --version`. Se aparecer um número, deu certo.

---

## Passo 2. Baixar o projeto e abrir a pasta no terminal

Escolha uma das formas:

- **Sem Git:** nesta página do GitHub, clique em **Code → Download ZIP** e descompacte onde preferir. A pasta pode vir com o nome `prospecteezy-main`.
- **Com Git:** `git clone https://github.com/gutomec/prospecteezy.git`

Depois entre na pasta pelo terminal.

**macOS:** digite `cd ` (com espaço no final), arraste a pasta do projeto do Finder para a janela do Terminal e aperte Enter.

**Windows:** abra a pasta no Explorador de Arquivos, clique na barra de endereço, digite `powershell` e aperte Enter.

Todos os comandos a partir daqui são digitados **dentro dessa pasta**.

---

## Passo 3. Instalar e iniciar

Na primeira vez:

```bash
bun install
```

Para iniciar:

```bash
bun run start
```

Quando aparecer `prospecteezy no ar em http://localhost:3000`, abra o navegador em **http://localhost:3000**. A primeira abertura demora alguns segundos, porque a interface é preparada na hora.

Deixe o terminal aberto enquanto usa. Para desligar, volte ao terminal e aperte `Ctrl + C`. Nos próximos dias, basta abrir a pasta no terminal e rodar `bun run start` de novo.

---

## Passo 4. Configurar a chave do Serper

1. Crie sua conta em https://serper.dev e copie a chave no menu **API Key**.
2. No prospecteezy, clique em **Configurações** no topo da página.
3. No bloco **Chave do Serper**, cole a chave e clique em **Salvar**.
4. Se quiser conferir, clique em **Testar (gasta 1 crédito)**.

A chave fica guardada criptografada na pasta `data/`. A tela mostra só os 4 últimos caracteres.

> Também é possível colocar a chave num arquivo `.env` (copie `.env.example` para `.env` e preencha `SERPER_API_KEY`). Se as duas existirem, vale a da tela de Configurações.

---

## Passo 5. Preencher o perfil da empresa

Ainda em **Configurações**, preencha o bloco **Perfil da empresa**: nome, site, o que vocês fazem, oferta, clientes ideais, diferenciais, tom de voz, assinatura e chamada para ação. A IA usa esse perfil para redigir as mensagens para os leads. Sem IA, ele não é obrigatório.

---

## Passo 6. Fazer a primeira busca

Na aba **Leads**, clique em **Nova busca** e escreva um pedido como:

- `Busque 50 clínicas odontológicas em Curitiba-PR`
- `Busque os 100 principais escritórios de advocacia em São Paulo-SP`
- `mais 50` (continua a última busca, trazendo empresas novas sem repetir as anteriores)

Sem IA, o pedido é lido por regras: use **"em"** antes da cidade e informe a sigla do estado (`Feira de Santana-BA`). O sistema mostra o progresso e preenche a tabela. Os e-mails são procurados nos sites das empresas logo em seguida e podem levar alguns minutos.

**Não há limite de quantidade.** A coleta segue até atingir o número pedido ou até o Google Maps não ter mais empresas para aquela combinação de nicho e cidade. É normal vir menos do que o pedido: o sistema traz só o que existe, sem inventar e sem repetir. Para ampliar, varie o termo (sinônimos e especialidades) ou a cidade.

**Histórico de buscas.** O painel **Buscas**, na aba Leads, lista todas as buscas feitas, com a quantidade de leads e o status (**Em andamento**, **Disponível** ou **Esgotada**). Em cada uma você pode:

- **Ver leads**: filtra a tabela só com os leads daquela busca;
- **Buscar mais**: continua a busca de onde parou;
- **Outra cidade**: repete o nicho em outra região.

**Tags.** Você pode dar tags a uma busca (todos os leads que ela trouxer recebem as tags) ou selecionar leads na tabela e usar **Tags** para adicionar ou remover em lote. Depois, filtre a tabela por uma ou mais tags. As tags aparecem também na ficha do lead, na exportação CSV e na lista de leads da aba WhatsApp.

Na tabela você pode filtrar, ordenar, abrir a ficha de cada lead e selecionar vários para **Validar WhatsApp**, **Enriquecer e-mails**, **Tags**, **Enviar mensagem**, exportar em CSV ou excluir.

Cada página de resultados (10 empresas) consome 1 crédito do Serper, e você só paga pelas páginas realmente buscadas. Acompanhe o saldo no painel do Serper.

---

## Passo 7 (opcional). Ativar a inteligência artificial

1. Em **Configurações**, no bloco **Provedores de IA**, clique em **Adicionar**.
2. Escolha o tipo (OpenAI, Google Gemini, Anthropic, OpenRouter ou Compatível com OpenAI), dê um nome, escolha o modelo e cole a chave de API. Para "Compatível com OpenAI", informe também a URL base do serviço.
3. Clique em **Testar** e depois em **Ativar**.

Com um provedor ativo, o botão **Assistente** abre um chat onde você pode pedir, por exemplo:

- "Encontre dentistas em Curitiba que atendam convênio"
- "Quais leads têm WhatsApp e e-mail?"
- "Pesquise mais sobre o lead #38 e proponha um enriquecimento"
- "Redija uma mensagem para o lead #38"

**Toda ação pede a sua aprovação antes de acontecer**: buscas que gastam créditos do Serper (com a estimativa de créditos), leitura de sites, gravação de dados num lead e envio de mensagens. Consultas à sua própria base de leads não precisam de aprovação. Depois de cada coleta, o assistente informa o resultado real (quantas empresas novas vieram e quantos créditos foram gastos) e, se o Google Maps tiver menos do que o pedido, sugere variações de termo e de cidade.

Para desligar a IA, escolha **Usar modo clássico** no mesmo bloco. Se o provedor falhar (chave inválida, falta de crédito), o assistente mostra o erro e oferece repetir o pedido no modo clássico.

---

## Passo 8 (opcional). Conectar o WhatsApp

Use um **número dedicado**. A conexão usa uma biblioteca não oficial (veja [Licença e avisos legais](#licença-e-avisos-legais)), e o WhatsApp pode bloquear números que fazem muitas consultas ou envios.

1. Na aba **WhatsApp**, clique em **Conectar WhatsApp**. Um QR code aparece.
2. No celular, abra o WhatsApp e vá em **Configurações → Aparelhos conectados → Conectar um aparelho**.
3. Aponte a câmera para o QR code.

A conexão fica salva e volta sozinha quando o servidor reinicia.

**Conversas e mídia.** A aba WhatsApp mostra suas conversas com fotos, vídeos, áudios, documentos e figurinhas, e permite responder com texto e anexos. Para economizar espaço em disco, **nenhuma mídia é baixada automaticamente**: clique em **Baixar** num arquivo, ou em **Carregar arquivos** no topo da conversa para baixar todos de uma vez. Essa janela mostra quanto espaço será usado e pode pedir ao seu celular o histórico da conversa para recuperar arquivos antigos.

**Validação e campanhas.** Na aba Leads, selecione leads e use **Validar WhatsApp** para descobrir quais números têm WhatsApp. Depois, **Enviar mensagem** abre o editor de campanha, com campos como `{{name}}`, `{{category}}` e `{{website}}` e prévia com um lead real. As campanhas respeitam limites de envio por minuto e por hora e não enviam entre 21h e 8h (horário de Brasília). Dentro de uma campanha, cada número recebe uma única mensagem, e números que já receberam mensagem de outra campanha nos últimos 7 dias são pulados. Uma campanha pausada pode ser retomada.

---

## Problemas comuns

**`bun: command not found` ou "bun não é reconhecido"**
Feche e abra o terminal depois de instalar o Bun.

**A busca responde que falta a chave do Serper**
Salve a chave em **Configurações → Chave do Serper** (Passo 4).

**"Port 3000 is in use" ou "address already in use"**
Outro programa usa a porta 3000. Inicie com outra porta: `PORT=3001 bun run start` (no Windows PowerShell: `$env:PORT=3001; bun run start`) e acesse http://localhost:3001.

**O QR code do WhatsApp expirou**
Ele muda a cada 20 a 60 segundos. Feche e clique em **Conectar WhatsApp** de novo.

**Uma mídia aparece como "Mídia indisponível"**
Use **Carregar arquivos** no topo da conversa com a opção de recuperar arquivos antigos marcada. O celular precisa estar online.

**Atualizei o projeto e a tela não mudou**
Reinicie o servidor (`Ctrl + C` e `bun run start`) e recarregue a página com `Cmd + Shift + R` (macOS) ou `Ctrl + Shift + R` (Windows/Linux).

---

## Onde ficam seus dados

| Arquivo em `data/` | Conteúdo |
|---|---|
| `prospecteezy.db` | Pesquisas, leads, histórico de cada lead, configurações, provedores de IA e conversas com o assistente. |
| `whatsapp.db` | Sessão do WhatsApp conectado, conversas, contatos e campanhas. Quem tiver esse arquivo acessa a conta. |
| `wa-media/` | Mídias do WhatsApp que você baixou ou enviou. |
| `.master.key` | Chave que protege as chaves de API salvas na tela de Configurações. |

Para fazer backup, desligue o servidor e copie a pasta `data/` inteira. O `.master.key` precisa ir junto com os bancos: sem ele, as chaves salvas ficam ilegíveis e precisam ser cadastradas de novo. Nunca compartilhe `.master.key` nem `whatsapp.db`.

---

## LGPD

O sistema coleta apenas dados públicos de empresas: resultados do Google Maps (via Serper.dev) e contatos publicados nos próprios sites. Cada lead guarda a origem e a data da coleta, e o histórico registra cada alteração. O robô que visita os sites se identifica, respeita o `robots.txt`, lê no máximo 3 páginas por site e não acessa endereços da rede local. O uso dos dados para contato comercial e o envio de mensagens são responsabilidade de quem opera o sistema.

---

## Para desenvolvedores

- `bun run dev` inicia com recarga automática do servidor e da interface.
- `bun test` roda os testes (Serper, IA e WhatsApp simulados, sem rede). `bunx tsc --noEmit` confere os tipos.
- Backend em `src/` (Bun + SQLite): `agent/` (parser e jobs), `ingest/` (Serper e crawler), `db/`, `settings/` (segredos cifrados), `ai/` (AI SDK v7) e `whatsapp/` (Baileys, com README próprio).
- Interface em `src/client/` (React 19, Tailwind 4, shadcn/ui, AI Elements), servida pelo próprio Bun sem etapa de build. Veja `src/client/README.md`.
- Contrato completo da API: [`docs/api.md`](docs/api.md).

---

## Licença e avisos legais

O código do prospecteezy usa a licença **MIT** (arquivo [`LICENSE`](LICENSE)): você pode usar, modificar e redistribuir, inclusive comercialmente, mantendo o aviso de copyright.

O projeto usa e inclui trabalho de terceiros, listado em [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md):

- **Incluído no repositório:** componentes do shadcn/ui (MIT) e do AI Elements, da Vercel (Apache-2.0, com os arquivos alterados marcados). Os textos dessas licenças estão na pasta [`licenses/`](licenses).
- **Baixado pelo `bun install`, não incluído:** cerca de 350 bibliotecas, quase todas sob MIT, Apache-2.0, BSD ou ISC. Duas têm cláusula de compartilhamento: a **libsignal** (GPL-3.0), usada pelo Baileys na criptografia do WhatsApp, e a libvips (LGPL-3.0), opcional. Se você redistribuir o programa **com** as dependências incluídas (por exemplo, com a pasta `node_modules` ou como executável único), precisa cumprir a GPL-3.0 da libsignal.

**Sem vínculo com terceiros.** O prospecteezy é independente e não tem vínculo, patrocínio ou aprovação de WhatsApp/Meta, Google, Serper, OpenAI, Anthropic, OpenRouter ou qualquer outra empresa citada. Esses nomes são marcas dos seus donos.

**WhatsApp não oficial.** A conexão com o WhatsApp usa o Baileys, uma biblioteca não oficial. Esse uso não é autorizado pelos Termos de Serviço do WhatsApp e pode levar ao bloqueio do número. Use um número dedicado e por sua conta e risco.

**Responsabilidade de uso.** Quem opera o sistema responde pelo uso dos dados coletados e pelas mensagens enviadas, conforme a LGPD, o GDPR ou a lei de proteção de dados aplicável no seu país, e pelos termos de uso do Serper e dos provedores de IA. O software é fornecido "no estado em que se encontra", sem garantias, como diz a licença MIT.

Para atualizar a lista de terceiros depois de mudar dependências: `bun run notices`.
