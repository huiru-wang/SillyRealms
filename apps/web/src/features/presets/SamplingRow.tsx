import { useId } from 'react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Field';
import { Range } from '../../components/ui/Range';
import { samplingError, samplingNumber, type SamplingField } from './sampling';
import styles from './Presets.module.css';

type Props = {
  field: SamplingField;
  value?: number | string;
  onChange: (value: number | string | undefined) => void;
};

export function SamplingRow({ field, value, onChange }: Props) {
  const id = useId();
  const error = samplingError(field, value);
  const custom = value !== undefined;
  const numeric = custom ? samplingNumber(value) : field.initial;
  const help = id + '-help';
  return <div className={styles.parameterRow + ' ' + styles.samplingRow} role="group" aria-labelledby={id}>
    <div className={styles.settingCopy}>
      <strong id={id}>{field.label}</strong>
      <p id={help}>{field.help}</p>
    </div>
    <div className={styles.samplingControls}>
      {custom ? <>
        <div className={styles.samplingInputs}>
          <div className={styles.samplingScale}>
            <Range min={field.min} max={field.max} step={0.01} value={Number.isFinite(numeric) ? numeric : field.initial}
              aria-label={field.label + '滑块'} aria-describedby={help} onChange={event => onChange(event.target.valueAsNumber)} />
            <div aria-hidden="true"><span>{field.min}</span>{field.min < 0 && <span>0</span>}<span>{field.max}</span></div>
          </div>
          <Input className={styles.samplingNumber} inputMode="decimal" value={value} aria-label={field.label + '精确值'}
            aria-invalid={!!error} aria-describedby={error ? help + ' ' + id + '-error' : help}
            onChange={event => onChange(event.target.value)}
            onBlur={() => { if (!error && typeof value === 'string') onChange(numeric); }} />
        </div>
        {error && <p id={id + '-error'} className="sr-field-error">{error}</p>}
      </> : <span className={styles.samplingDefault}>模型默认</span>}
      <Button variant="text" size="compact" aria-label={field.label + (custom ? '恢复默认' : '自定义')}
        onClick={() => onChange(custom ? undefined : field.initial)}>{custom ? '恢复默认' : '自定义'}</Button>
    </div>
  </div>;
}
