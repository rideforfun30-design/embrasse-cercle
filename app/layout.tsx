import type { Metadata } from 'next';
import { headers } from 'next/headers';
import './globals.css';
export async function generateMetadata():Promise<Metadata>{
 const h=await headers();const host=(h.get('host')||'').split(':')[0];
 const title=host==='embrasse.tv'?'EMBRASSE — oppening soon':host==='location.embrasse.tv'?'EMBRASSE — location soon':'Le cercle EMBRASSE — Entre créatifs';
 return {title,description:host==='embrasse.tv'||host==='location.embrasse.tv'?'EMBRASSE. Prochainement.':'Les bons outils entre créatifs. Retrouvez votre cercle, partagez vos abonnements et suivez vos participations.',icons:{icon:'/favicon.svg'}};
}
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="fr"><body>{children}</body></html>}
