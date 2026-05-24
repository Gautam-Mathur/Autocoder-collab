import { useState } from "react";
import { Check, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface FeatureSuggestionItem {
  name: string;
  description: string;
  capabilityDescription: string;
}

interface FeatureSuggestionsProps {
  suggestions: FeatureSuggestionItem[];
  headerText: string;
  onConfirm: (selected: string[], rejected: string[]) => void;
  disabled?: boolean;
}

export function FeatureSuggestions({ suggestions, headerText, onConfirm, disabled }: FeatureSuggestionsProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitted, setSubmitted] = useState(false);

  const toggle = (name: string) => {
    if (submitted || disabled) return;
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const handleConfirm = () => {
    setSubmitted(true);
    const selectedList = suggestions.filter(s => selected.has(s.name)).map(s => s.name);
    const rejectedList = suggestions.filter(s => !selected.has(s.name)).map(s => s.name);
    onConfirm(selectedList, rejectedList);
  };

  if (submitted) {
    const selectedNames = suggestions.filter(s => selected.has(s.name)).map(s => s.name);
    if (selectedNames.length === 0) {
      return (
        <div className="my-3 rounded-lg border border-border/50 bg-muted/20 px-4 py-3">
          <p className="text-xs text-muted-foreground">No additional features selected — proceeding with your original request.</p>
        </div>
      );
    }
    return (
      <div className="my-3 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3">
        <div className="flex items-center gap-1.5 mb-1.5">
          <Check className="h-3.5 w-3.5 text-primary" />
          <span className="text-xs font-medium text-primary">Features added</span>
        </div>
        <p className="text-xs text-muted-foreground">{selectedNames.join(", ")}</p>
      </div>
    );
  }

  return (
    <div className="my-4 rounded-xl border border-border/60 bg-card/50 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/40 bg-muted/30">
        <Sparkles className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-medium text-foreground">{headerText}</span>
      </div>

      <div className="p-2 space-y-1">
        {suggestions.map((s) => {
          const isSelected = selected.has(s.name);
          return (
            <button
              key={s.name}
              onClick={() => toggle(s.name)}
              disabled={disabled}
              className={cn(
                "w-full flex items-start gap-3 px-3 py-2.5 rounded-lg text-left transition-all",
                "hover:bg-accent/50",
                isSelected && "bg-primary/8 ring-1 ring-primary/25",
                disabled && "opacity-50 cursor-not-allowed"
              )}
            >
              <div className={cn(
                "flex-shrink-0 mt-0.5 w-4.5 h-4.5 rounded border-[1.5px] flex items-center justify-center transition-all",
                isSelected
                  ? "bg-primary border-primary text-primary-foreground"
                  : "border-muted-foreground/40 bg-background"
              )}>
                {isSelected && <Check className="h-3 w-3" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground leading-tight">{s.name}</div>
                <div className="text-xs text-muted-foreground mt-0.5 leading-snug">{s.capabilityDescription}</div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between px-4 py-2.5 border-t border-border/40 bg-muted/20">
        <span className="text-xs text-muted-foreground">
          {selected.size === 0
            ? "Select features to include"
            : `${selected.size} selected`}
        </span>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleConfirm}
            disabled={disabled}
            className="h-7 px-3 text-xs"
          >
            Skip
          </Button>
          <Button
            size="sm"
            onClick={handleConfirm}
            disabled={disabled}
            className="h-7 px-3 text-xs gap-1.5"
          >
            <Check className="h-3 w-3" />
            Confirm{selected.size > 0 ? ` (${selected.size})` : ""}
          </Button>
        </div>
      </div>
    </div>
  );
}
