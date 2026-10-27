# Ajouter un abonnement depuis le site du service

Dans « Proposer un abonnement », le lien est facultatif. Un nom est proposé depuis le domaine et reste modifiable. Les marques courantes sont reconnues ; aucun titre HTML distant n’est lu. Une correction manuelle du nom reste conservée si le lien change. Le lien nettoyé est conservé lors de la sauvegarde et peut être changé ou effacé dans « Modifier ». Les paramètres de requête et le fragment ne sont pas conservés pour éviter de stocker des jetons ou du suivi.

L’icône est demandée au service favicon de Google avec uniquement le domaine validé, sans envoyer le chemin ni l’adresse de la page EMBRASSE. Le domaine du service est donc communiqué à Google. Si l’icône ne charge pas, les initiales sont affichées. Aucun secret ni compte Google supplémentaire n’est nécessaire.

La validation commune navigateur/serveur accepte les liens HTTP(S) publics et ajoute HTTPS aux domaines saisis sans protocole. Elle refuse les identifiants dans l’URL, les IP, noms locaux, protocoles actifs, ports inhabituels et URL normalisées trop longues. Le serveur ne télécharge jamais arbitrairement la page fournie. Les accès aux abonnements restent contrôlés par cercle.

La migration additive0008 ajoute website_url nullable ; les abonnements précédents restent utilisables sans lien. En édition, un client qui omet le champ conserve le lien existant ; null ou une chaîne vide l’efface.

## Inscription directe temporaire

Le réglage ACCESS_CONTROL_ENABLED=false retire seulement la validation manuelle des comptes. La connexion avec mot de passe et l’adresse email vérifiée restent obligatoires. Le profil authentifié rejoint le seul cercle défini par ACCESS_DEFAULT_WORKSPACE_ID avec le rôle membre, sans modifier un rôle déjà attribué. Les limites de capacité et d’espaces sont conservées. Aucun rôle administrateur n’est attribué par adresse non vérifiée.

Le réglage peut repasser à true pour rétablir les demandes d’accès. Les anciens statuts ne sont pas convertis silencieusement en approbations : un compte admis pendant la phase ouverte peut alors devoir demander son approbation. Les demandes pour rejoindre un abonnement précis et l’accord sur le préavis restent distincts. Aucun paiement n’est activé par ces changements.
