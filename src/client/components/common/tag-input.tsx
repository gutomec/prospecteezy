// Tag combobox: chosen tags as removable chips + a text field with
// autocomplete (GET /api/tags by default). Enter or comma adds the highlighted
// suggestion or creates the typed tag; Backspace on an empty field removes the
// last chip; Esc closes the list. The list renders in-flow (not a portal) so it
// works inside popovers, dialogs and the lead drawer without clipping.
import { PlusIcon } from "lucide-react";
import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { formatInt } from "@/lib/format";
import { useTags } from "@/lib/queries";
import { addTag, MAX_TAGS_PER_REQUEST, removeTag, TAG_MAX_LENGTH, tagSuggestions, type TagOption } from "@/lib/tags";
import { cn } from "@/lib/utils";
import { TagBadge } from "./tag-badge";

interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  /** Suggestions; default = every existing tag (with lead counts). */
  suggestions?: TagOption[];
  /** Allow tags that aren't in the suggestions (default true). */
  allowCreate?: boolean;
  placeholder?: string;
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  className?: string;
}

export function TagInput({
  value,
  onChange,
  suggestions,
  allowCreate = true,
  placeholder = "Adicionar tag…",
  id,
  autoFocus,
  disabled,
  className,
  ...aria
}: TagInputProps) {
  const allTags = useTags();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // With an empty field, Enter picks a suggestion only after arrow navigation
  // (otherwise it submits the surrounding form).
  const [navigated, setNavigated] = useState(false);
  const full = value.length >= MAX_TAGS_PER_REQUEST;

  const source = useMemo<TagOption[]>(
    () => suggestions ?? (allTags.data ?? []).map((t) => ({ name: t.name, count: t.lead_count })),
    [suggestions, allTags.data],
  );
  const { options, create } = useMemo(() => tagSuggestions(source, value, text, { allowCreate }), [source, value, text, allowCreate]);
  // Rows: suggestions first, then "Criar “x”".
  const rows: Array<{ kind: "option"; option: TagOption } | { kind: "create"; name: string }> = [
    ...options.map((option) => ({ kind: "option" as const, option })),
    ...(create ? [{ kind: "create" as const, name: create }] : []),
  ];
  const showList = open && !full && rows.length > 0;
  const activeIndex = Math.min(active, rows.length - 1);

  const commit = (name: string) => {
    onChange(addTag(value, name));
    setText("");
    setActive(0);
    setNavigated(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    // A comma is a separator, never part of a tag name.
    if (event.key === "," && !text.trim()) {
      event.preventDefault();
      return;
    }
    if (event.key === "Enter" || (event.key === "," && text.trim())) {
      if (!text.trim() && !(showList && navigated)) return; // let Enter submit the surrounding form
      event.preventDefault();
      const row = showList ? rows[activeIndex] : null;
      if (row) commit(row.kind === "option" ? row.option.name : row.name);
      else if (allowCreate && text.trim()) commit(text);
      return;
    }
    if (event.key === "Backspace" && text === "" && value.length > 0) {
      event.preventDefault();
      onChange(value.slice(0, -1));
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setNavigated(true);
      if (rows.length) setActive((i) => (Math.min(i, rows.length - 1) + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
      return;
    }
    if (event.key === "Escape" && showList) {
      event.preventDefault();
      event.stopPropagation(); // close the list, not the surrounding popover/dialog
      setOpen(false);
    }
  };

  return (
    <div className={cn("space-y-1", className)}>
      <div
        className={cn(
          "flex min-h-9 w-full flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-2 py-1 shadow-xs transition-[color,box-shadow] dark:bg-input/30",
          "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
          disabled && "pointer-events-none opacity-50",
        )}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            inputRef.current?.focus();
          }
        }}
      >
        {value.map((tag) => (
          <TagBadge key={tag} name={tag} onRemove={disabled ? undefined : () => onChange(removeTag(value, tag))} />
        ))}
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList ? `${listId}-${activeIndex}` : undefined}
          aria-label={aria["aria-label"]}
          aria-describedby={aria["aria-describedby"]}
          value={text}
          maxLength={TAG_MAX_LENGTH + 10}
          disabled={disabled || full}
          autoFocus={autoFocus}
          autoComplete="off"
          placeholder={full ? `Máximo de ${MAX_TAGS_PER_REQUEST} tags` : value.length ? "" : placeholder}
          onChange={(e) => {
            setText(e.target.value);
            setActive(0);
            setNavigated(false);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          className="h-6 min-w-24 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-sm"
        />
      </div>
      {showList && (
        <ul id={listId} role="listbox" aria-label="Sugestões de tags" className="max-h-44 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-sm">
          {rows.map((row, i) => (
            <li
              key={row.kind === "option" ? `o:${row.option.name}` : `c:${row.name}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              // mousedown, not click: keeps focus in the input (no blur → list stays coherent).
              onMouseDown={(e) => {
                e.preventDefault();
                commit(row.kind === "option" ? row.option.name : row.name);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
                i === activeIndex && "bg-accent text-accent-foreground",
              )}
            >
              {row.kind === "option" ? (
                <>
                  <TagBadge name={row.option.name} />
                  {row.option.count !== undefined && (
                    <span className="text-muted-foreground ml-auto text-xs tabular">{formatInt(row.option.count)}</span>
                  )}
                </>
              ) : (
                <>
                  <PlusIcon className="text-muted-foreground size-3.5" aria-hidden="true" />
                  <span className="truncate">
                    Criar “<span className="font-medium">{row.name}</span>”
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
