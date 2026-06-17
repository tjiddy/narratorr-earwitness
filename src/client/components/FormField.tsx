import type { ReactNode } from 'react';

// Adapted from Narratorr (components/settings/FormField.tsx). Narratorr's version is
// react-hook-form-coupled; earwitness uses plain controlled inputs, so this takes
// value/onChange directly. Same class language as the source so it looks identical.

const baseInputClass =
  'w-full px-4 py-3 bg-background border rounded-xl focus-ring focus:border-transparent transition-all';

interface FormFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  type?: 'text' | 'number' | 'password' | 'url';
  placeholder?: string | undefined;
  readOnly?: boolean | undefined;
  disabled?: boolean | undefined;
  min?: number | undefined;
  max?: number | undefined;
  step?: number | string | undefined;
  className?: string | undefined;
  hint?: ReactNode;
}

export function FormField({
  id,
  label,
  value,
  onChange,
  error,
  type = 'text',
  placeholder,
  readOnly,
  disabled,
  min,
  max,
  step,
  className,
  hint,
}: FormFieldProps) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium mb-2">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        readOnly={readOnly}
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        className={`${baseInputClass} ${error ? 'border-destructive' : 'border-border'} ${readOnly ? 'opacity-60 cursor-not-allowed' : ''} ${className ?? ''}`}
        placeholder={placeholder}
      />
      {error && <p className="text-sm text-destructive mt-1">{error}</p>}
      {hint && !error && <p className="text-sm text-muted-foreground mt-1">{hint}</p>}
    </div>
  );
}
