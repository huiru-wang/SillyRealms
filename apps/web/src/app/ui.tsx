import {useTranslation} from 'react-i18next';
import {Button} from '../components/ui/Button';
import {AlertCircle,LoaderCircle} from 'lucide-react';
import {errorMessage} from '../i18n/errors.ts';
export function ErrorNotice({message,onRetry}:{message:unknown;onRetry?:()=>void}){
  const {t}=useTranslation('common');
  return <div className="notice" role="alert"><span className="inline-status"><AlertCircle size={17}/>{errorMessage(message)}</span>{onRetry&&<Button size="compact" onClick={onRetry}>{t('retry')}</Button>}</div>;
}
export function Loading({text}:{text?:string}){
  const {t}=useTranslation('common');
  return <div className="loading-panel" role="status"><LoaderCircle className="spinner-icon" size={18}/>{text??t('loading')}</div>;
}
