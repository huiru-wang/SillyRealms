import {PageHeader} from '../../components/ui/PageHeader';
import {Box,ChevronRight} from 'lucide-react';
import {Link} from 'react-router-dom';
import styles from './MorePage.module.css';
export function MorePage(){
  return <section className={styles.page}><PageHeader title="更多"/>
    <div className={styles.group}><h2>配置</h2><Link className={styles.row} to="/models"><span className={styles.label}><Box size={19}/>模型</span><ChevronRight size={18} aria-hidden="true"/></Link><Link className={styles.row} to="/settings"><span>应用设置</span><ChevronRight size={18}/></Link></div>
  </section>;
}
