import { CheckIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme, type ThemePreference } from "@/components/theme/theme-provider";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

const OPTIONS: Array<[ThemePreference, string, typeof SunIcon]> = [
  ["light", "Claro", SunIcon],
  ["dark", "Escuro", MoonIcon],
  ["system", "Sistema", MonitorIcon],
];

export function ThemeToggle() {
  const { preference, resolved, setPreference } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Tema: ${resolved === "dark" ? "escuro" : "claro"}. Alterar tema`}>
          {resolved === "dark" ? <MoonIcon /> : <SunIcon />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {OPTIONS.map(([value, label, Icon]) => (
          <DropdownMenuItem key={value} onSelect={() => setPreference(value)}>
            <Icon /> {label}
            {preference === value && <CheckIcon className="ml-auto" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
