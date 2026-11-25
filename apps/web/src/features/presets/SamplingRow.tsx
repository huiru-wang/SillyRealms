import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Field';
import { Range } from '../../components/ui/Range';
import { Switch } from '../../components/ui/Switch';
import { samplingError, samplingNumber, type SamplingField } from './sampling';
import styles from './Presets.module.css';

type Props = {
  field: SamplingField;
  value?: number | string;
  onChange: (value: number | string | undefined) => void;
};

export function SamplingRow({ field, value, onChange }: Props) {
  const { t } = useTranslation('presets');
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [editingFrom, setEditingFrom] = useState<number | string | null>(null);
  const custom = value !== undefined;
  const numeric = custom ? samplingNumber(value) : field.initial;
  const error = samplingError(field, value);
  const help = id + '-help';
  const errorId = id + '-error';

  function finishEdit(next: number | string, restoreFocus: boolean) {
    if (next !== value) onChange(next);
    setEditingFrom(null);
    if (restoreFocus) requestAnimationFrame(() => buttonRef.current?.focus({ preventScroll: true }));
  }

  return <div className={styles.parameterRow + ' ' + styles.samplingRow} data-custom={custom} role="group" aria-labelledby={id}>
    <div className={styles.settingCopy}>
      <strong id={id}>{field.label}</strong>
      {custom && <p id={help}>{field.help}</p>}
    </div>
    <div className={styles.samplingToggle}>
      <label htmlFor={id + '-custom'}>{t('custom')}</label>
      <Switch id={id + '-custom'} checked={custom} label={t('customizeSampling', { label: field.label })}
        describedBy={custom ? help : id + '-default'} onChange={enabled => {
          setEditingFrom(null);
          onChange(enabled ? field.initial : undefined);
        }} />
    </div>
    {custom ? <div className={styles.samplingControls}>
      <div className={styles.samplingScale}>
        <Range min={field.min} max={field.max} step={0.01} value={error ? field.initial : numeric}
          aria-label={t('samplingSlider', { label: field.label })} aria-describedby={help}
          onChange={event => { setEditingFrom(null); onChange(event.target.valueAsNumber); }} />
        <div aria-hidden="true"><span>{field.min}</span>{field.min < 0 && <span>0</span>}<span>{field.max}</span></div>
      </div>
      <div className={styles.samplingValue}>
        {editingFrom === null && typeof value === 'number'
          ? <Button ref={buttonRef} size="compact" aria-label={t('editSamplingValue', { label: field.label, value })}
              aria-describedby={help} onClick={() => setEditingFrom(value)}>
              {value}
            </Button>
          : <Input autoFocus={editingFrom !== null} inputMode="decimal" value={value} aria-label={t('samplingExact', { label: field.label })}
              aria-invalid={!!error} aria-describedby={error ? help + ' ' + errorId : help}
              onFocus={event => {
                if (editingFrom === null) setEditingFrom(value);
                event.currentTarget.select();
              }}
              onChange={event => onChange(event.target.value)}
              onBlur={() => {
                if (error) setEditingFrom(null);
                else finishEdit(numeric, false);
              }}
              onKeyDown={event => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === 'Enter') {
                  event.preventDefault();
                  if (!error) finishEdit(numeric, true);
                } else if (event.key === 'Escape' && editingFrom !== null) {
                  event.preventDefault();
                  finishEdit(editingFrom, true);
                }
              }} />}
      </div>
      {error && <p id={errorId} className="sr-field-error">{error}</p>}
    </div> : <span id={id + '-default'} className={styles.samplingDefault}>{t('modelDefault')}</span>}
  </div>;
}
