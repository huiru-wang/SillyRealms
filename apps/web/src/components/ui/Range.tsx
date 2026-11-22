import type { InputHTMLAttributes } from 'react';

export function Range(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'>) {
  return <input {...props} type="range" className="sr-range" />;
}
