import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import BureauApp from './components/BureauApp';
export const dynamic = 'force-dynamic';
export default async function Home() {
  const h = await headers();
  const host = (h.get('host') || '').split(':')[0];
  if(host.endsWith('.chatgpt.site'))redirect('https://abonnement.embrasse.tv/');
  if (host === 'embrasse.tv' || host === 'location.embrasse.tv') {
    return <main style={{minHeight:'100svh',display:'grid',placeItems:'center',background:'#000',color:'#fff',fontFamily:'Helvetica,"Helvetica Neue",Arial,sans-serif'}}><h1 style={{fontSize:'clamp(24px,4vw,60px)',fontWeight:400,letterSpacing:'-.035em',padding:24,textAlign:'center'}}>{host === 'location.embrasse.tv' ? 'location soon' : 'oppening soon'}</h1></main>;
  }
  return <BureauApp />;
}
