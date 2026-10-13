// Generates THIRD_PARTY_NOTICES.md from the installed dependencies and the
// license texts in licenses/. Run after changing dependencies:
//   bun run notices
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const NODE_MODULES = join(ROOT, "node_modules");

interface Pkg {
  name: string;
  version: string;
  license: string;
  repository: string;
}

function normalizeRepo(raw: string): string {
  const url = raw
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^github:/, "https://github.com/");
  return /^[\w.-]+\/[\w.-]+$/.test(url) ? `https://github.com/${url}` : url;
}

function readPkg(dir: string): Pkg | null {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return null;
  const p = JSON.parse(readFileSync(file, "utf8"));
  let license = p.license ?? (Array.isArray(p.licenses) ? p.licenses.map((l: { type: string }) => l.type).join(" OR ") : "");
  if (typeof license === "object") license = license.type;
  const repo = typeof p.repository === "string" ? p.repository : p.repository?.url ?? p.homepage ?? "";
  return {
    name: p.name,
    version: p.version,
    license: license || "não declarada",
    repository: normalizeRepo(String(repo)),
  };
}

function allPackages(): Pkg[] {
  const out: Pkg[] = [];
  for (const entry of readdirSync(NODE_MODULES)) {
    if (entry.startsWith(".")) continue;
    const dirs = entry.startsWith("@")
      ? readdirSync(join(NODE_MODULES, entry)).map((s) => join(NODE_MODULES, entry, s))
      : [join(NODE_MODULES, entry)];
    for (const dir of dirs) {
      const pkg = readPkg(dir);
      if (pkg) out.push(pkg);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const directNames = new Set(Object.keys({ ...rootPkg.dependencies, ...rootPkg.devDependencies }));
const packages = allPackages();
const direct = packages.filter((p) => directNames.has(p.name));
const byLicense = new Map<string, number>();
for (const p of packages) byLicense.set(p.license, (byLicense.get(p.license) ?? 0) + 1);
const copyleft = packages.filter((p) => /GPL|MPL|EPL/i.test(p.license));

const licenseText = (file: string) => readFileSync(join(ROOT, "licenses", file), "utf8").trim();

const md = `# Avisos de terceiros

O código do prospecteezy é distribuído sob a licença MIT (arquivo \`LICENSE\`). Este arquivo lista o código de terceiros que acompanha o projeto e as bibliotecas que ele usa, com as respectivas licenças.

Gerado por \`bun run notices\` a partir das dependências instaladas. Não edite à mão.

## 1. Código de terceiros incluído neste repositório

### shadcn/ui

Os componentes em \`src/client/components/ui/\` foram gerados a partir do shadcn/ui (https://github.com/shadcn-ui/ui) e adaptados para o projeto.

\`\`\`
${licenseText("shadcn-ui-MIT.txt")}
\`\`\`

### AI Elements (Vercel)

Os componentes em \`src/client/components/ai-elements/\` (exceto \`streamdown-safety.ts\`, escrito para este projeto) vêm do AI Elements (https://github.com/vercel/ai-elements) e foram **modificados**: textos da interface em português, regras de segurança de links, remoção de plugins de renderização e outros ajustes. Cada arquivo modificado traz um aviso no topo.

\`\`\`
${licenseText("ai-elements-NOTICE.txt")}
\`\`\`

O texto completo da Apache License 2.0 está em \`licenses/Apache-2.0.txt\`.

## 2. Bibliotecas instaladas pelo \`bun install\`

Estas bibliotecas **não estão incluídas** no repositório nem no pacote .zip. Cada pessoa as baixa do registro npm ao rodar \`bun install\`, sob as licenças dos seus autores.

### Dependências diretas

| Pacote | Versão | Licença | Origem |
|---|---|---|---|
${direct.map((p) => `| ${p.name} | ${p.version} | ${p.license} | ${p.repository} |`).join("\n")}

### Todas as bibliotecas instaladas, por licença

${packages.length} pacotes no total:

| Licença | Pacotes |
|---|---|
${[...byLicense.entries()].sort((a, b) => b[1] - a[1]).map(([l, n]) => `| ${l} | ${n} |`).join("\n")}

### Licenças com obrigações de compartilhamento

${copyleft.length === 0 ? "Nenhuma." : copyleft.map((p) => `- **${p.name}@${p.version}** (${p.license}), ${p.repository || "sem repositório declarado"}`).join("\n")}

${copyleft.some((p) => p.name === "libsignal") ? `A **libsignal** (GPL-3.0) é usada pelo Baileys para a criptografia do WhatsApp. Como o prospecteezy é distribuído apenas como código-fonte, sem a libsignal, o código do projeto pode permanecer sob MIT, que é compatível com a GPL-3.0. Quem distribuir o programa **junto com as dependências** (por exemplo, com a pasta \`node_modules\` incluída ou como um executável único) passa a distribuir uma obra que contém código GPL-3.0 e precisa cumprir essa licença, o que inclui oferecer o código-fonte completo e o texto da GPL-3.0.\n\n` : ""}${copyleft.some((p) => /libvips/.test(p.name)) ? `A **libvips** (LGPL-3.0) chega como binário opcional do pacote \`sharp\`, dependência opcional do Baileys. Ela é carregada como biblioteca separada e não é incluída no projeto.\n\n` : ""}
## 3. Marcas e serviços de terceiros

WhatsApp, Google, Google Maps, Serper, OpenAI, Anthropic, Gemini e OpenRouter são marcas de seus respectivos donos. O prospecteezy é um projeto independente, sem vínculo, patrocínio ou aprovação dessas empresas. O uso de cada serviço está sujeito aos termos dele.
`;

await Bun.write(join(ROOT, "THIRD_PARTY_NOTICES.md"), md);
console.log(`THIRD_PARTY_NOTICES.md: ${packages.length} pacotes, ${direct.length} diretos, ${copyleft.length} com copyleft`);
