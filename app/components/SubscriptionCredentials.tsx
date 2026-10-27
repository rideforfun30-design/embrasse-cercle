"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Eye, EyeOff, KeyRound, LockKeyhole, RefreshCw, ShieldCheck } from "lucide-react";
import { generateServicePassword } from "../../lib/service-password";

type VaultMetadata = {
  configured: boolean;
  canManage: boolean;
  canReveal: boolean;
  hasCredentials: boolean;
  paymentRequired: boolean;
  joined: boolean;
  defaultEmail: string | null;
  period: string;
  updatedAt: string | null;
  restriction: "unconfigured" | "membership" | "payment" | "missing_credentials" | null;
};
type MetadataState = { subscriptionId: string; value: VaultMetadata };
type RevealedCredentials = { subscriptionId: string; email: string; password: string };
type Operation = "reveal" | "save" | null;
const SECRET_LIFETIME_MS = 60_000;
class VaultUiError extends Error {}
function pageIsHidden(): boolean { return document.visibilityState === "hidden"; }

function requestError(status: number, action: "metadata" | "reveal" | "save"): string {
  if (status === 401) return "Reconnectez-vous pour consulter les identifiants du service.";
  if (status === 403) return action === "save" ? "Seul le responsable peut modifier ces identifiants." : "L’adhésion au groupe et le paiement doivent être confirmés avant l’accès aux identifiants.";
  if (status === 404) return "Les identifiants de ce service ne sont pas disponibles.";
  if (status === 429) return "Trop de demandes rapprochées. Patientez un instant avant de réessayer.";
  if (status === 503) return "Le coffre n’est pas encore disponible. Réessayez plus tard.";
  if (status === 400 && action === "save") return "Vérifiez l’adresse e-mail et le mot de passe, qui doit compter entre 12 et 512 caractères.";
  return action === "save" ? "Les identifiants n’ont pas pu être enregistrés. Réessayez." : "Le coffre n’a pas pu être chargé. Réessayez.";
}

function parseMetadata(value: unknown): VaultMetadata | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<VaultMetadata>;
  if (![candidate.configured, candidate.canManage, candidate.canReveal, candidate.hasCredentials, candidate.paymentRequired, candidate.joined].every(flag => typeof flag === "boolean")) return null;
  if (candidate.defaultEmail !== null && (typeof candidate.defaultEmail !== "string" || candidate.defaultEmail.length > 254)) return null;
  if (typeof candidate.period !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(candidate.period)) return null;
  if (candidate.updatedAt !== null && typeof candidate.updatedAt !== "string") return null;
  if (candidate.restriction !== null && !["unconfigured", "membership", "payment", "missing_credentials"].includes(String(candidate.restriction))) return null;
  return { configured: candidate.configured === true, canManage: candidate.canManage === true, canReveal: candidate.canReveal === true, hasCredentials: candidate.hasCredentials === true, paymentRequired: candidate.paymentRequired === true, joined: candidate.joined === true, defaultEmail: candidate.defaultEmail, period: candidate.period, updatedAt: candidate.updatedAt, restriction: candidate.restriction as VaultMetadata["restriction"] };
}

function restrictionText(metadata: VaultMetadata): string {
  if (!metadata.configured || metadata.restriction === "unconfigured") return "Le coffre n’est pas encore activé. Les identifiants ne sont pas accessibles pour le moment.";
  if (metadata.restriction === "membership" || !metadata.joined && !metadata.canManage) return "Rejoignez ce groupe pour accéder à ses identifiants après confirmation du paiement.";
  if (metadata.restriction === "payment" || metadata.paymentRequired && !metadata.canReveal) return "Les identifiants restent verrouillés jusqu’à la confirmation du paiement de votre part. Aucun paiement ne peut être validé manuellement ici.";
  if (!metadata.hasCredentials || metadata.restriction === "missing_credentials") return "Le responsable n’a pas encore ajouté les identifiants de ce service.";
  return "Les identifiants ne sont pas accessibles avec votre compte pour le moment.";
}

export default function SubscriptionCredentials({ subscriptionId }: { subscriptionId: string }) {
  const titleId = useId();
  const emailId = useId();
  const passwordId = useId();
  const revealEmailId = useId();
  const revealPasswordId = useId();
  const [metadataState, setMetadataState] = useState<MetadataState | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<Operation>(null);
  const [revealed, setRevealed] = useState<RevealedCredentials | null>(null);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftEmail, setDraftEmail] = useState("");
  const [draftPassword, setDraftPassword] = useState("");
  const [draftVisible, setDraftVisible] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);
  const operationVersion = useRef(0);
  const lastSubscriptionId = useRef(subscriptionId);
  const metadata = metadataState?.subscriptionId === subscriptionId ? metadataState.value : null;
  const credentials = revealed?.subscriptionId === subscriptionId ? revealed : null;
  const hasPlaintext = Boolean(credentials || editing && (draftEmail || draftPassword));

  const clearSecrets = useCallback(() => {
    operationVersion.current += 1;
    activeRequest.current?.abort();
    activeRequest.current = null;
    setRevealed(null);
    setPasswordVisible(false);
    setDraftPassword("");
    setDraftEmail("");
    setDraftVisible(false);
    setEditing(false);
    setBusy(null);
  }, []);

  useEffect(() => {
    clearSecrets(); setLoading(true); setError(""); setMetadataState(null);
    if (lastSubscriptionId.current !== subscriptionId) { lastSubscriptionId.current = subscriptionId; setNotice(""); }
    const controller = new AbortController();
    let current = true;
    void (async () => {
      try {
        const response = await fetch(`/api/vault/subscriptions/${encodeURIComponent(subscriptionId)}`, { method: "GET", cache: "no-store", credentials: "same-origin", signal: controller.signal });
        if (!response.ok) throw new VaultUiError(requestError(response.status, "metadata"));
        const value = parseMetadata(await response.json());
        if (!value) throw new VaultUiError("La réponse du coffre n’a pas pu être vérifiée. Réessayez.");
        if (current) setMetadataState({ subscriptionId, value });
      } catch (caught) {
        if (current && !controller.signal.aborted) setError(caught instanceof TypeError ? "La connexion au coffre a été interrompue. Réessayez." : caught instanceof VaultUiError ? caught.message : "Le coffre n’a pas pu être chargé.");
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => {
      current = false; controller.abort(); operationVersion.current += 1;
      activeRequest.current?.abort(); activeRequest.current = null;
    };
  }, [subscriptionId, reload, clearSecrets]);

  useEffect(() => {
    const hide = () => { if (pageIsHidden()) clearSecrets(); };
    const leave = () => clearSecrets();
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", leave);
    return () => { document.removeEventListener("visibilitychange", hide); window.removeEventListener("pagehide", leave); };
  }, [clearSecrets]);

  useEffect(() => {
    if (!hasPlaintext) return;
    const timer = window.setTimeout(() => { clearSecrets(); setNotice("Les identifiants ont été masqués automatiquement après une minute."); }, SECRET_LIFETIME_MS);
    return () => window.clearTimeout(timer);
  }, [hasPlaintext, clearSecrets]);

  async function revealCredentials() {
    if (!metadata?.canReveal || !metadata.hasCredentials || busy || pageIsHidden()) return;
    clearSecrets(); setError(""); setNotice(""); setBusy("reveal");
    const version = operationVersion.current;
    const controller = new AbortController(); activeRequest.current = controller;
    try {
      const response = await fetch(`/api/vault/subscriptions/${encodeURIComponent(subscriptionId)}/reveal`, { method: "POST", cache: "no-store", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}", signal: controller.signal });
      if (!response.ok) throw new VaultUiError(requestError(response.status, "reveal"));
      const result: unknown = await response.json();
      const value = result as Partial<RevealedCredentials> | null;
      if (!value || typeof value.email !== "string" || value.email.length > 254 || typeof value.password !== "string" || !value.password.length || value.password.length > 512) throw new VaultUiError("Les identifiants reçus n’ont pas pu être vérifiés.");
      if (version !== operationVersion.current || controller.signal.aborted || pageIsHidden()) return;
      setRevealed({ subscriptionId, email: value.email, password: value.password });
    } catch (caught) {
      if (version === operationVersion.current && !controller.signal.aborted) setError(caught instanceof TypeError ? "La connexion au coffre a été interrompue. Réessayez." : caught instanceof VaultUiError ? caught.message : "Les identifiants n’ont pas pu être affichés.");
    } finally {
      if (version === operationVersion.current) { activeRequest.current = null; setBusy(null); }
    }
  }

  function editCredentials() {
    if (!metadata?.canManage || !metadata.configured) return;
    clearSecrets(); setError(""); setNotice(""); setDraftEmail(metadata.defaultEmail ?? ""); setEditing(true);
  }

  function suggestPassword() {
    if (busy || pageIsHidden()) return;
    setError(""); setNotice(""); setDraftVisible(false);
    try { setDraftPassword(generateServicePassword()); }
    catch { setError("La proposition n’a pas pu être générée. Vous pouvez choisir le mot de passe vous-même."); }
  }

  async function saveCredentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!metadata?.canManage || !metadata.configured || busy || pageIsHidden()) return;
    setError(""); setNotice("");
    if (draftPassword.length < 12 || draftPassword.length > 512) { setError("Le mot de passe doit compter entre 12 et 512 caractères."); return; }
    const controller = new AbortController(); activeRequest.current = controller;
    const version = operationVersion.current; setBusy("save");
    try {
      const response = await fetch(`/api/vault/subscriptions/${encodeURIComponent(subscriptionId)}/credentials`, { method: "PUT", cache: "no-store", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: draftEmail.trim(), password: draftPassword }), signal: controller.signal });
      if (!response.ok) throw new VaultUiError(requestError(response.status, "save"));
      const result: unknown = await response.json();
      if (!result || typeof result !== "object" || (result as { ok?: boolean }).ok !== true) throw new VaultUiError("L’enregistrement n’a pas pu être confirmé. Actualisez le coffre avant de réessayer.");
      if (version !== operationVersion.current || controller.signal.aborted || pageIsHidden()) return;
      clearSecrets();
      setNotice("Identifiants enregistrés dans le coffre. Le mot de passe du service n’a pas été changé.");
      setReload(value => value + 1);
    } catch (caught) {
      if (version === operationVersion.current && !controller.signal.aborted) setError(caught instanceof TypeError ? "La connexion a été interrompue. Actualisez le coffre avant de réessayer l’enregistrement." : caught instanceof VaultUiError ? caught.message : "Les identifiants n’ont pas pu être enregistrés.");
    } finally {
      if (version === operationVersion.current) { activeRequest.current = null; setBusy(null); }
    }
  }

  return <section className="vault-section" aria-labelledby={titleId}>
    <div className="vault-heading"><span className="vault-symbol"><KeyRound size={19}/></span><div><h3 id={titleId}>Les identifiants du service.</h3><p>Un accès commun, réservé aux participants autorisés.</p></div></div>
    {loading || !metadata && !error ? <p className="vault-status" role="status">Chargement du coffre…</p> : metadata ? <>
      {!credentials && (!metadata.canReveal || !metadata.hasCredentials) && <div className="vault-lock"><LockKeyhole size={20}/><p>{restrictionText(metadata)}</p></div>}
      {metadata.canReveal && metadata.hasCredentials && !credentials && <div className="vault-reveal-action"><p>Affichez les identifiants uniquement au moment de vous connecter au service.</p><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => void revealCredentials()}><Eye size={16}/>{busy === "reveal" ? "Ouverture…" : "Afficher les identifiants"}</button></div>}
      {credentials && <div className="vault-revealed"><label className="vault-label" htmlFor={revealEmailId}>Adresse e-mail<input id={revealEmailId} type="email" value={credentials.email} readOnly autoComplete="off" spellCheck={false}/></label><label className="vault-label" htmlFor={revealPasswordId}>Mot de passe</label><div className="vault-password-row"><input id={revealPasswordId} type={passwordVisible ? "text" : "password"} value={credentials.password} readOnly autoComplete="off" autoCapitalize="none" spellCheck={false}/><button type="button" className="button secondary small" onClick={() => setPasswordVisible(value => !value)} aria-pressed={passwordVisible}>{passwordVisible ? <EyeOff size={16}/> : <Eye size={16}/>}<span>{passwordVisible ? "Cacher" : "Voir"}</span></button></div><div className="vault-secret-footer"><p><ShieldCheck size={14}/> Masquage automatique après une minute ou en quittant cette page.</p><button type="button" className="button text-button small" onClick={clearSecrets}>Masquer les identifiants</button></div></div>}
      {metadata.canManage && metadata.configured && !editing && <button type="button" className="button secondary small vault-edit-button" disabled={Boolean(busy)} onClick={editCredentials}>{metadata.hasCredentials ? "Modifier les identifiants" : "Ajouter les identifiants"}</button>}
      {metadata.canManage && metadata.configured && editing && <form className="vault-editor" onSubmit={event => void saveCredentials(event)} autoComplete="off"><p className="vault-editor-note">Configurez d’abord ces identifiants sur le service, puis enregistrez-les ici. Ce coffre ne change pas son mot de passe.</p><label className="vault-label" htmlFor={emailId}>E-mail du compte commun<input id={emailId} name="serviceEmail" type="email" value={draftEmail} onChange={event => setDraftEmail(event.target.value)} autoComplete="off" maxLength={254} required disabled={Boolean(busy)}/></label><label className="vault-label" htmlFor={passwordId}>Mot de passe du service</label><div className="vault-password-row"><input id={passwordId} name="servicePassword" type={draftVisible ? "text" : "password"} value={draftPassword} onChange={event => setDraftPassword(event.target.value)} minLength={12} maxLength={512} autoComplete="new-password" autoCapitalize="none" spellCheck={false} required disabled={Boolean(busy)}/><button type="button" className="button secondary small" onClick={() => setDraftVisible(value => !value)} disabled={Boolean(busy)} aria-pressed={draftVisible}>{draftVisible ? <EyeOff size={16}/> : <Eye size={16}/>}<span>{draftVisible ? "Cacher" : "Voir"}</span></button></div><button type="button" className="button text-button small vault-suggest-button" disabled={Boolean(busy)} onClick={suggestPassword}><RefreshCw size={14}/> Proposer un mot de passe</button><p className="vault-helper">Une proposition amusante, créée sur votre appareil sans IA ni envoi à un autre service. Vous pouvez la modifier. La saisie est effacée après une minute.</p><div className="vault-editor-actions"><button type="button" className="button secondary small" disabled={Boolean(busy)} onClick={clearSecrets}>Annuler et effacer</button><button type="submit" className="button primary small" disabled={Boolean(busy)}>{busy === "save" ? "Enregistrement…" : "Enregistrer les identifiants"}</button></div></form>}
    </> : null}
    {notice && <p className="vault-notice" role="status">{notice}</p>}
    {error && <p className="vault-error" role="alert">{error}</p>}
    {!loading && !editing && !credentials && <button type="button" className="button text-button small vault-refresh-button" disabled={Boolean(busy)} onClick={() => { setNotice(""); setReload(value => value + 1); }}>Actualiser le coffre</button>}
  </section>;
}
