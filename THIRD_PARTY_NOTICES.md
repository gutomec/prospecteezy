# Avisos de terceiros

O código do prospecteezy é distribuído sob a licença MIT (arquivo `LICENSE`). Este arquivo lista o código de terceiros que acompanha o projeto e as bibliotecas que ele usa, com as respectivas licenças.

Gerado por `bun run notices` a partir das dependências instaladas. Não edite à mão.

## 1. Código de terceiros incluído neste repositório

### shadcn/ui

Os componentes em `src/client/components/ui/` foram gerados a partir do shadcn/ui (https://github.com/shadcn-ui/ui) e adaptados para o projeto.

```
MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### AI Elements (Vercel)

Os componentes em `src/client/components/ai-elements/` (exceto `streamdown-safety.ts`, escrito para este projeto) vêm do AI Elements (https://github.com/vercel/ai-elements) e foram **modificados**: textos da interface em português, regras de segurança de links, remoção de plugins de renderização e outros ajustes. Cada arquivo modificado traz um aviso no topo.

```
Copyright 2023 Vercel, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

O texto completo da Apache License 2.0 está em `licenses/Apache-2.0.txt`.

## 2. Bibliotecas instaladas pelo `bun install`

Estas bibliotecas **não estão incluídas** no repositório nem no pacote .zip. Cada pessoa as baixa do registro npm ao rodar `bun install`, sob as licenças dos seus autores.

### Dependências diretas

| Pacote | Versão | Licença | Origem |
|---|---|---|---|
| @ai-sdk/anthropic | 4.0.78 | Apache-2.0 | https://github.com/vercel/ai |
| @ai-sdk/google | 4.0.93 | Apache-2.0 | https://github.com/vercel/ai |
| @ai-sdk/openai | 4.0.91 | Apache-2.0 | https://github.com/vercel/ai |
| @ai-sdk/openai-compatible | 3.0.67 | Apache-2.0 | https://github.com/vercel/ai |
| @ai-sdk/react | 4.0.140 | Apache-2.0 | https://github.com/vercel/ai |
| @openrouter/ai-sdk-provider | 3.1.0 | Apache-2.0 | https://github.com/OpenRouterTeam/ai-sdk-provider |
| @radix-ui/react-use-controllable-state | 1.3.0 | MIT | https://github.com/radix-ui/primitives |
| @tanstack/react-query | 5.104.2 | MIT | https://github.com/TanStack/query |
| @types/bun | 1.3.14 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/qrcode | 1.5.6 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/react | 19.3.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/react-dom | 19.3.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| ai | 7.0.137 | Apache-2.0 | https://github.com/vercel/ai |
| baileys | 7.0.0-rc13 | MIT | https://github.com/WhiskeySockets/Baileys |
| bun-plugin-tailwind | 0.1.2 | MIT | https://github.com/tailwindlabs/tailwindcss |
| class-variance-authority | 0.7.1 | Apache-2.0 | https://github.com/joe-bell/cva |
| cmdk | 1.1.1 | MIT | https://github.com/pacocoursey/cmdk |
| cn | 0.4.0 | MIT | https://github.com/shadcn-ui/cn |
| lucide-react | 1.55.0 | ISC | https://github.com/lucide-icons/lucide |
| motion | 14.1.0 | MIT | https://github.com/motiondivision/motion |
| nanoid | 6.0.2 | MIT | https://github.com/ai/nanoid |
| qrcode | 1.5.4 | MIT | https://github.com/soldair/node-qrcode |
| qrcode-terminal | 0.12.0 | Apache 2.0 | https://github.com/gtanner/qrcode-terminal |
| radix-ui | 1.8.0 | MIT | https://github.com/radix-ui/primitives |
| react | 19.3.0 | MIT | https://github.com/react/react |
| react-dom | 19.3.0 | MIT | https://github.com/react/react |
| sonner | 2.0.8 | MIT | https://github.com/emilkowalski/sonner |
| streamdown | 2.7.0 | Apache-2.0 | https://github.com/vercel/streamdown |
| tailwindcss | 4.3.3 | MIT | https://github.com/tailwindlabs/tailwindcss |
| tw-animate-css | 1.4.0 | MIT | https://github.com/Wombosvideo/tw-animate-css |
| typescript | 5.9.3 | Apache-2.0 | https://github.com/microsoft/TypeScript |
| use-stick-to-bottom | 1.1.6 | MIT | https://github.com/samdenty/use-stick-to-bottom |
| zod | 4.6.6 | MIT | https://github.com/colinhacks/zod |

### Todas as bibliotecas instaladas, por licença

344 pacotes no total:

| Licença | Pacotes |
|---|---|
| MIT | 290 |
| Apache-2.0 | 21 |
| BSD-3-Clause | 13 |
| ISC | 13 |
| LGPL-3.0-or-later | 1 |
| BSD-2-Clause | 1 |
| (AFL-2.1 OR BSD-3-Clause) | 1 |
| GPL-3.0 | 1 |
| BlueOak-1.0.0 | 1 |
| Apache 2.0 | 1 |
| 0BSD | 1 |

### Licenças com obrigações de compartilhamento

- **@img/sharp-libvips-darwin-arm64@1.3.2** (LGPL-3.0-or-later), https://github.com/lovell/sharp-libvips
- **libsignal@6.0.0** (GPL-3.0), https://github.com/WhiskeySockets/libsignal-node

A **libsignal** (GPL-3.0) é usada pelo Baileys para a criptografia do WhatsApp. Como o prospecteezy é distribuído apenas como código-fonte, sem a libsignal, o código do projeto pode permanecer sob MIT, que é compatível com a GPL-3.0. Quem distribuir o programa **junto com as dependências** (por exemplo, com a pasta `node_modules` incluída ou como um executável único) passa a distribuir uma obra que contém código GPL-3.0 e precisa cumprir essa licença, o que inclui oferecer o código-fonte completo e o texto da GPL-3.0.

A **libvips** (LGPL-3.0) chega como binário opcional do pacote `sharp`, dependência opcional do Baileys. Ela é carregada como biblioteca separada e não é incluída no projeto.


## 3. Marcas e serviços de terceiros

WhatsApp, Google, Google Maps, Serper, OpenAI, Anthropic, Gemini e OpenRouter são marcas de seus respectivos donos. O prospecteezy é um projeto independente, sem vínculo, patrocínio ou aprovação dessas empresas. O uso de cada serviço está sujeito aos termos dele.
