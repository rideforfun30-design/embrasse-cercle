import type { ZxcvbnFactory } from "@zxcvbn-ts/core";
let checker:Promise<ZxcvbnFactory>|undefined;
async function strengthChecker(){
  if(!checker)checker=Promise.all([import("@zxcvbn-ts/core"),import("@zxcvbn-ts/language-common"),import("@zxcvbn-ts/language-fr")]).then(([core,common,fr])=>new core.ZxcvbnFactory({translations:fr.translations,graphs:common.adjacencyGraphs,dictionary:{...common.dictionary,...fr.dictionary}}));
  return checker;
}
/** Local only: passwords never leave this server for scoring or breach checks. */
export async function chosenPasswordStrength(password:unknown,userInputs:string[]=[]):Promise<{ok:boolean;code?:string;message?:string}>{
  if(typeof password!=="string")return {ok:false,code:"PASSWORD_REQUIRED",message:"Choisissez un mot de passe."};
  if(password.length<12)return {ok:false,code:"PASSWORD_TOO_SHORT",message:"Choisissez un mot de passe d’au moins douze caractères."};
  if(password.length>128)return {ok:false,code:"PASSWORD_TOO_LONG",message:"Le mot de passe doit contenir au maximum 128 caractères."};
  const score=(await strengthChecker()).check(password,["embrasse","embrasse.tv",...userInputs]).score;
  return score>=3?{ok:true}:{ok:false,code:"WEAK_PASSWORD",message:"Ce mot de passe est trop facile à deviner. Choisissez une phrase plus longue avec plusieurs mots, sans répétition évidente."};
}
