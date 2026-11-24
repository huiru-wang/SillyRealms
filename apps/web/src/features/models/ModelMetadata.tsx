import {useTranslation} from 'react-i18next';
import { modelFacts } from './catalog';
import type { CatalogModel } from './types';
import styles from './ModelsPage.module.css';

export function ModelMetadata({ model }: { model: CatalogModel }) {
  const {t} = useTranslation('models');
  return <dl className={styles.modelSpecs} aria-label={t('modelParameters')} data-model-parameters>
    {modelFacts(model).map(fact => <div key={fact.field} className={fact.wide ? styles.specWide : undefined} data-model-field={fact.field}>
      <dt title={fact.field}>{fact.label}</dt>
      <dd><span>{fact.value}</span>{fact.detail && <small>{fact.detail}</small>}</dd>
    </div>)}
  </dl>;
}
