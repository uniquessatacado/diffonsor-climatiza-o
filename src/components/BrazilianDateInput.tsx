import { useEffect, useId, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";
import { formatBrazilianDate, isValidIsoDate, maskBrazilianDate, parseBrazilianDate } from "../services/dateFormat";
import "./BrazilianDateInput.css";

type BrazilianDateInputProps = {
  value: string;
  onChange: (isoDate: string) => void;
  className?: string;
  ariaLabel?: string;
  disabled?: boolean;
  required?: boolean;
  id?: string;
};

/** Brazilian display/typing, while the questionnaire and native calendar keep ISO date values. */
export function BrazilianDateInput({
  value, onChange, className = "", ariaLabel = "Data", disabled = false, required = false, id,
}: BrazilianDateInputProps) {
  const errorId = useId();
  const [text, setText] = useState(() => formatBrazilianDate(value, { fallback: "" }));
  const [touched, setTouched] = useState(false);
  const lastPublishedValue = useRef(value);
  const isoValue = isValidIsoDate(value) ? value : parseBrazilianDate(value) ?? "";
  const invalid = text.length > 0 && !parseBrazilianDate(text);

  useEffect(() => {
    if (value !== lastPublishedValue.current) {
      setText(formatBrazilianDate(value, { fallback: "" }));
    }
    lastPublishedValue.current = value;
  }, [value]);

  function publish(next: string) {
    lastPublishedValue.current = next;
    onChange(next);
  }

  return (
    <div className="brazilian-date-field">
      <div className="brazilian-date-control">
        <input
          id={id}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          className={`${className} brazilian-date-text`}
          placeholder="DD/MM/AAAA"
          aria-label={`${ariaLabel} (DD/MM/AAAA)`}
          aria-invalid={Boolean(touched && invalid)}
          aria-describedby={touched && invalid ? errorId : undefined}
          disabled={disabled}
          required={required}
          maxLength={10}
          value={text}
          onBlur={() => setTouched(true)}
          onChange={(event) => {
            const next = maskBrazilianDate(event.target.value);
            setText(next);
            publish(parseBrazilianDate(next) ?? "");
          }}
        />
        <span className="brazilian-date-calendar">
          <CalendarDays size={23} aria-hidden="true" />
          <input
            type="date"
            lang="pt-BR"
            aria-label={`Abrir calendário: ${ariaLabel}`}
            disabled={disabled}
            value={isoValue}
            onChange={(event) => {
              const next = event.target.value;
              if (next && !isValidIsoDate(next)) return;
              setText(formatBrazilianDate(next, { fallback: "" }));
              setTouched(false);
              publish(next);
            }}
          />
        </span>
      </div>
      {touched && invalid && <small className="brazilian-date-error" id={errorId}>Informe uma data válida no formato DD/MM/AAAA.</small>}
    </div>
  );
}
